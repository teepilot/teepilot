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

function stopEverything(reason) {
    if (job) { job.stop(); job = null; }
    watchConfig = null;
    status = `Stoppad: ${reason}`;
    console.log(`🛑 STOPPAT: ${reason}`);
}

async function checkTimes() {
    if (isRunning || !watchConfig) return;
    isRunning = true;

    let browser;
    try {
        console.log("--- Startar lättviktssökning ---");
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu", // Sparar minne
                "--no-first-run",
                "--no-zygote"
            ],
            executablePath: await chromium.executablePath(),
            headless: true
        });

        const page = await browser.newPage();
        
        // ⚡ OPTIMERING: Blockera bilder för att spara RAM
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setDefaultNavigationTimeout(120000); // 2 minuter

        console.log("1. Laddar Min Golf...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });

        // LOGIN
        await page.waitForSelector('input', { timeout: 30000 });
        const inputs = await page.$$("input");
        if (inputs.length >= 2) {
            console.log("2. Loggar in...");
            await inputs[0].type(watchConfig.golfId);
            await inputs[1].type(watchConfig.password);
            await inputs[1].press("Enter");
            await sleep(15000); // Vänta på omdirigering
        }

        // NAVIGATION
        console.log("3. Går till bokningsvyn...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });
        await sleep(10000);

        // VÄLJ BANA
        console.log("4. Väljer bana...");
        await page.waitForSelector('.v-select__slot', { timeout: 30000 });
        await page.click('.v-select__slot');
        await sleep(5000);
        
        const ok = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll(".v-list-item, span"));
            const target = items.find(i => i.innerText.includes("Tournament Course"));
            if (target) { target.click(); return true; }
            return false;
        });
        if (!ok) throw new Error("Banan hittades inte");

        // VÄLJ DATUM
        console.log("5. Väljer datum...");
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('div, span')).find(s => s.innerText.includes('När vill du spela'));
            if (btn) btn.click();
        });
        await sleep(5000);

        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        await page.evaluate((d) => {
            const btns = Array.from(document.querySelectorAll('.v-btn__content'));
            const target = btns.find(b => b.innerText.trim() === d);
            if (target) target.click();
        }, day);
        
        await sleep(10000);

        // LÄS TIDER
        console.log("6. Läser tider...");
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, .v-card'))
                .map(el => el.innerText)
                .filter(txt => /\d{2}:\d{2}/.test(txt) && !txt.includes("Fullbokad") && !txt.includes("Ej bokningsbar"))
                .map(txt => txt.match(/\d{2}:\d{2}/)[0]);
        });

        const found = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (found) {
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: watchConfig.email,
                subject: "Tid hittad! ⛳",
                html: `<h3>Tid hittad!</h3><p>Kl <b>${found}</b> på Vasatorp.</p>`
            });
            stopEverything(`Träff vid ${found}`);
        } else {
            status = `Sökte ${new Date().toLocaleTimeString()} (Inga tider)`;
            console.log("Inga tider lediga just nu.");
        }

    } catch (err) {
        console.log("❌ FEL:", err.message);
        stopEverything(`Krasch: ${err.message}`);
    } finally {
        if (browser) {
            console.log("7. Stänger webbläsare...");
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
    job = cron.schedule("*/10 * * * *", checkTimes); // Ändrat till 10 min för att inte stressa Render
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    stopEverything("Stoppad manuellt");
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));
app.listen(process.env.PORT || 3000);