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
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage", // Viktigt för minnet på Render
                "--disable-gpu"
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            protocolTimeout: 120000 // Vi dubblar protocol timeout för att slippa ditt felmeddelande
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // Blockera onödiga resurser för att spara CPU/Minne
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // 1. LOGIN
        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });

        console.log("[LOG] Väntar på inmatningsfält...");
        await page.waitForSelector("input[type='password']", { timeout: 30000 });

        // Vi använder page.evaluate för att fylla i fälten blixtsnabbt utan att Puppeteer behöver "vakta" fälten
        await page.evaluate((id, pw) => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const u = inputs.find(i => i.type === "text" || i.type === "email");
            const p = inputs.find(i => i.type === "password");
            if (u) u.value = id;
            if (p) p.value = pw;
        }, watchConfig.golfId, watchConfig.password);

        console.log("[LOG] Skickar inloggning...");
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 5000)); // Ge den tid att tugga inloggningen

        // 2. BOKNINGSSIDA
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 6000)); 

        // 3. DATUM & BANA (Körs i ett svep för att spara CPU-anrop)
        const dayToPick = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Söker datum ${dayToPick} och bana...`);

        const result = await page.evaluate((day) => {
            const btns = Array.from(document.querySelectorAll("button, span, div, p"));
            
            // Klicka datum
            const dateBtn = btns.find(el => el.innerText && el.innerText.trim() === day);
            if (dateBtn) dateBtn.click();
            
            // Klicka bana (Tournament Course)
            const courseBtn = btns.find(el => el.innerText && el.innerText.includes("Tournament Course"));
            if (courseBtn) courseBtn.click();
            
            return !!(dateBtn && courseBtn);
        }, dayToPick);

        console.log(`[LOG] Val utförda: ${result}`);
        await new Promise(r => setTimeout(r, 5000)); 

        // 4. LÄS TIDER
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        console.log("[INFO] Tider funna:", times.join(", "));
        
        const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available) {
            console.log("[MATCH] Skickar mail!");
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TeeTime hittad ⛳!",
                html: `<h2>Tid hittad: ${available}</h2>`
            });
            status = `Träff! ${available}`;
            stopEverything();
        } else {
            status = `Senaste koll: ${new Date().toLocaleTimeString()}`;
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Fel vid sökning...";
    } finally {
        if (browser) await browser.close();
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server redo!"));