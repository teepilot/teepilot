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
                "--js-flags=\"--max-old-space-size=256\"" // Begränsar minnesanvändning för JS
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // AGGRESSIV BLOCKERING för att spara RAM
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            // Vi blockerar ALLT utom själva dokumentet och scripts (som behövs för inlogg/bokning)
            if (['image', 'media', 'font', 'stylesheet', 'other'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // 1. LOGIN (Super snabb)
        console.log("[LOG] Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("input[type='password']", { timeout: 20000 });

        await page.evaluate((id, pw) => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const u = inputs.find(i => i.type === "text" || i.type === "email");
            const p = inputs.find(i => i.type === "password");
            if (u && p) { u.value = id; p.value = pw; }
        }, watchConfig.golfId, watchConfig.password);

        await page.keyboard.press('Enter');
        // Vänta på att sessionen skapas men inte på hela navigeringen
        await new Promise(r => setTimeout(r, 6000)); 

        // 2. BOKNINGSSIDA
        console.log("[LOG] Bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 8000)); 

        // 3. DATUM & BANA (Kör allt i ett hårt script för att spara CPU-anrop)
        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Väljer datum ${day}...`);

        const clickResult = await page.evaluate((d) => {
            const click = (txt) => {
                const e = Array.from(document.querySelectorAll("button, span, div, p"))
                               .find(el => el.innerText && el.innerText.trim().includes(txt));
                if (e) { e.click(); return true; }
                return false;
            };
            const dOk = click(d);
            const cOk = click("Tournament Course");
            return { dOk, cOk };
        }, day);

        console.log(`[LOG] Klickstatus: ${JSON.stringify(clickResult)}`);
        await new Promise(r => setTimeout(r, 6000)); 

        // 4. LÄS TIDER
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => /^\d{2}:\d{2}$/.test(text));
        });

        if (times.length > 0) {
            console.log(`[INFO] Hittade ${times.length} tider.`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);
            if (available) {
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "Tid hittad!",
                    html: `<b>Tid: ${available}</b>`
                });
                status = `Hittad: ${available}`;
                stopEverything();
            }
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Försöker igen...";
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

app.listen(process.env.PORT || 10000, () => console.log("Server online!"));