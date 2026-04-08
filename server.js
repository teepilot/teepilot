const { Resend } = require("resend");
const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

let job = null;
let watchConfig = null;
let isRunning = false;
let status = "Ingen aktiv bevakning";

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Funktion för att stoppa allt centralt
function stopEverything(reason) {
    if (job) {
        job.stop();
        job = null;
    }
    watchConfig = null;
    status = `Avslutad: ${reason}`;
    console.log(`BEVAKNING AVBRUTEN: ${reason}`);
}

async function checkTimes() {
    if (isRunning) {
        console.log("Körning pågår redan, hoppar över...");
        return;
    }
    
    if (!watchConfig) return;
    isRunning = true;

    let browser;
    try {
        console.log("--- Startar ny sökcykel ---");
        browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
            executablePath: await chromium.executablePath(),
            headless: true
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(90000); 
        
        console.log("Navigerar till bokning...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });

        // 1. LOGIN
        await page.waitForSelector('input', { timeout: 20000 }).catch(() => {});
        const inputs = await page.$$("input");
        if (inputs.length >= 2) {
            console.log("Loggar in...");
            await inputs[0].type(watchConfig.golfId);
            await inputs[1].type(watchConfig.password);
            await inputs[1].press("Enter");
            await sleep(10000);
        }

        // 2. COOKIES & STÄDNING
        console.log("Rensar cookies/overlays...");
        await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, span, div'));
            const cookieBtn = elements.find(e => e.innerText.toLowerCase().includes('acceptera') || e.innerText.toLowerCase().includes('ok'));
            if (cookieBtn) cookieBtn.click();
            document.querySelectorAll('[class*="modal"], [id*="sp_message"]').forEach(el => el.remove());
        });
        await sleep(3000);

        // 3. VÄLJ BANA (Dropdown) - Här dör det ofta
        console.log("Letar efter ban-väljaren...");
        await page.waitForSelector('.v-select__slot', { timeout: 15000 });
        await page.click('.v-select__slot');
        await sleep(3000);
        
        await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll(".v-list-item__title, .v-list-item, span"));
            const target = items.find(i => i.innerText.includes("Tournament Course"));
            if (target) target.click();
        });

        // 4. VÄLJ DATUM
        await sleep(3000);
        console.log("Öppnar kalender...");
        await page.evaluate(() => {
            const sections = Array.from(document.querySelectorAll('div, p, span'));
            const dateBtn = sections.find(s => s.innerText.includes('När vill du spela'));
            if (dateBtn) dateBtn.click();
        });
        
        await sleep(3000);
        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        
        await page.evaluate((d) => {
            const btnContents = Array.from(document.querySelectorAll('.v-btn__content'));
            const target = btnContents.find(b => b.innerText.trim() === d);
            if (target) target.click();
        }, day);
        
        await sleep(6000);

        // 5. KOLLA LEDIGA TIDER
        const available = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, .v-card'))
                .map(el => el.innerText)
                .filter(txt => /\d{2}:\d{2}/.test(txt) && !txt.includes("Fullbokad") && !txt.includes("Ej bokningsbar"))
                .map(txt => txt.match(/\d{2}:\d{2}/)[0]);
        });

        const match = available.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (match) {
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: watchConfig.email,
                subject: "TeeTime hittad! ⛳",
                html: `<p>Tid hittad: <b>${match}</b></p>`
            });
            stopEverything(`Tid hittad (${match})`);
        } else {
            status = `Senaste koll: ${new Date().toLocaleTimeString()} (Inga lediga tider)`;
        }

    } catch (err) {
        console.log("KRITISKT FEL:", err.message);
        // 🔥 Här avslutas bevakningen helt om ett fel uppstår (t.ex. timeout för v-select__slot)
        stopEverything(`Fel vid sökning: ${err.message}`);
    } finally {
        if (browser) {
            console.log("Stänger webbläsare...");
            await browser.close().catch(() => {});
        }
        isRunning = false;
    }
}

app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning aktiv";
    if (job) job.stop();
    isRunning = false; 
    checkTimes(); 
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    stopEverything("Stoppad manuellt");
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));
app.listen(process.env.PORT || 3000);