const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const { Resend } = require("resend");

const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const app = express();
app.use(cors());
app.use(express.json());

let job = null;
let watchConfig = null;
let status = "Ingen aktiv bevakning";
let isSearching = false;

app.get("/", (req, res) => res.send(`<h1>TeePilot Status</h1><p>${status}</p>`));

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    let browser = null;
    try {
        console.log(`--- [${new Date().toLocaleTimeString()}] Startar sökning ---`);
        
        browser = await puppeteer.launch({
            args: [
                ...chromium.args, 
                "--disable-blink-features=AutomationControlled", 
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process", // Hjälper minnet på små servrar
                "--no-zygote"
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        // Vi sätter en låg timeout för att inte ligga och dra minne i onödan
        page.setDefaultTimeout(25000); 
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // TOTAL BLOCKERING
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            // Vi tillåter ENDAST document och script. Allt annat (CSS, Bilder, Typsnitt, XHR-annonser) dör.
            if (['document', 'script', 'fetch', 'xhr'].includes(type)) req.continue();
            else req.abort();
        });

        // 1. LOGIN
        console.log("[LOG] Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
        
        await page.evaluate((id, pw) => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const u = inputs.find(i => i.type === "text" || i.type === "email");
            const p = inputs.find(i => i.type === "password");
            if (u && p) { u.value = id; p.value = pw; }
        }, watchConfig.golfId, watchConfig.password);

        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 5000)); 

        // 2. BOKNING
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 7000)); 

        // 3. VÄLJ BANA & DATUM
        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); 

        const results = await page.evaluate(async (d) => {
            const clickByText = (txt, exact = false) => {
                const el = Array.from(document.querySelectorAll("button, span, div, p"))
                               .find(e => exact ? e.innerText?.trim() === txt : e.innerText?.includes(txt));
                if (el) { el.click(); return true; }
                return false;
            };

            const c = clickByText("Tournament Course");
            // Vänta ett kort ögonblick inuti browsern
            await new Promise(r => setTimeout(r, 2000));
            const dOk = clickByText(d, true);
            
            return { c, dOk };
        }, day);

        console.log(`[LOG] Bana: ${results.c}, Datum: ${results.dOk}`);
        
        if (!results.c && !results.dOk) {
            throw new Error("Kunde inte hitta knappar - Minnet förmodligen för belastat");
        }

        await new Promise(r => setTimeout(r, 5000)); 

        // 4. LÄS TIDER
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => /^\d{2}:\d{2}$/.test(text));
        });

        if (times.length > 0) {
            console.log(`[INFO] Tider: ${times.length} st.`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);
            if (available) {
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "TeeTime!",
                    html: `<b>Tid hittad: ${available}</b>`
                });
                status = `Träff: ${available}`;
                stopEverything();
            }
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Försöker igen nästa cykel...";
    } finally {
        if (browser) {
            // Vi tvingar ner webbläsaren snabbt för att frigöra RAM till nästa cron-jobb
            await browser.close().catch(() => {});
            browser = null;
        }
        isSearching = false;
        console.log("-----------------------------------------------");
    }
}

async function stopEverything() {
    if (job) { job.stop(); job = null; }
    watchConfig = null;
    status = "Ingen aktiv bevakning";
    isSearching = false;
}

app.post("/start", async (req, res) => {
    await stopEverything();
    watchConfig = req.body;
    status = "Bevakning startad";
    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

app.listen(process.env.PORT || 10000);