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
                "--js-flags=\"--max-old-space-size=256\""
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // AGGRESSIV BLOCKERING för att överleva på Renders gratis-RAM
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // 1. LOGIN
        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("input[type='password']", { timeout: 25000 });

        await page.evaluate((id, pw) => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const u = inputs.find(i => i.type === "text" || i.type === "email");
            const p = inputs.find(i => i.type === "password");
            if (u && p) { u.value = id; p.value = pw; }
        }, watchConfig.golfId, watchConfig.password);

        console.log("[LOG] Skickar inloggning...");
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 6000)); 

        // 2. GÅ TILL BOKNING
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 8000)); 

        // 3. VÄLJ BANA OCH DATUM (NY ORDNING)
        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); 

        // Steg A: Klicka bana
        console.log("[LOG] Väljer Tournament Course...");
        const courseOk = await page.evaluate(() => {
            window.scrollTo(0, 0); // Scrolla upp för säkerhets skull
            const el = Array.from(document.querySelectorAll("button, span, div, p"))
                           .find(e => e.innerText && e.innerText.includes("Tournament Course"));
            if (el) { el.click(); return true; }
            return false;
        });
        console.log(`[LOG] Bana klickad: ${courseOk}`);

        await new Promise(r => setTimeout(r, 4000)); 

        // Steg B: Klicka datum
        console.log(`[LOG] Väljer datum: ${day}...`);
        const dateOk = await page.evaluate((d) => {
            const el = Array.from(document.querySelectorAll("button, span, div, p"))
                           .find(e => e.innerText && e.innerText.trim() === d);
            if (el) { el.click(); return true; }
            return false;
        }, day);
        console.log(`[LOG] Datum klickat: ${dateOk}`);
        
        await new Promise(r => setTimeout(r, 6000)); 

        // 4. LÄS AV TIDER
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => /^\d{2}:\d{2}$/.test(text));
        });

        if (times.length > 0) {
            console.log(`[INFO] Hittade ${times.length} tider: ${times.join(", ")}`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

            if (available) {
                console.log(`[MATCH] Hittade ledig tid: ${available}! Skickar mail...`);
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "TeeTime hittad ⛳!",
                    html: `<h2>Tid hittad: ${available}</h2><p>Bana: Tournament Course</p><p>Datum: ${watchConfig.date}</p>`
                });
                status = `Träff! ${available}`;
                stopEverything();
            } else {
                status = `Sökt ${new Date().toLocaleTimeString()} (Ingen i ditt intervall)`;
            }
        } else {
            console.log("[WARN] Inga tidsknappar hittades på sidan.");
            status = "Hittade inga tider";
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Fel vid sökning...";
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
        isSearching = false;
        console.log("-----------------------------------------------");
    }
}

async function stopEverything() {
    console.log("Stoppar all bevakning...");
    if (job) { job.stop(); job = null; }
    watchConfig = null;
    status = "Ingen aktiv bevakning";
    isSearching = false;
}

app.post("/start", async (req, res) => {
    await stopEverything();
    watchConfig = req.body;
    status = "Bevakning startad";
    console.log("Startar för:", watchConfig.golfId);
    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`TeePilot redo på port ${PORT}`));