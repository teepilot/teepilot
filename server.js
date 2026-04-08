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
    if (job) {
        job.stop();
        job = null;
    }
    watchConfig = null;
    status = `Bevakning avslutad: ${reason}`;
    console.log(`🛑 ALLT STOPPAT: ${reason}`);
}

async function checkTimes() {
    if (isRunning || !watchConfig) return;
    isRunning = true;

    let browser;
    try {
        console.log("--- 🏁 Startar sökcykel ---");
        browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
            executablePath: await chromium.executablePath(),
            headless: true
        });

        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(90000); 
        
        console.log("1. Går till Min Golf...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });

        // LOGIN
        const loginPresent = await page.waitForSelector('input', { timeout: 10000 }).catch(() => false);
        if (loginPresent) {
            console.log("2. Loggar in...");
            const inputs = await page.$$("input");
            await inputs[0].type(watchConfig.golfId);
            await inputs[1].type(watchConfig.password);
            await inputs[1].press("Enter");
            await sleep(10000);
        }

        // FORCE NAVIGATE (Om vi hamnat fel efter login)
        console.log("3. Säkerställer bokningsvy...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });
        await sleep(5000);

        // COOKIES
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, span, div'));
            const ok = btns.find(b => b.innerText.toLowerCase().includes('acceptera') || b.innerText.toLowerCase().includes('ok'));
            if (ok) ok.click();
            document.querySelectorAll('[class*="modal"], [id*="sp_message"]').forEach(el => el.remove());
        }).catch(() => {});

        // VÄLJ BANA
        console.log("4. Letar efter ban-väljaren...");
        try {
            await page.waitForSelector('.v-select__slot', { timeout: 20000 });
            await page.click('.v-select__slot');
            await sleep(3000);
            
            const courseFound = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll(".v-list-item__title, .v-list-item, span"));
                const target = items.find(i => i.innerText.includes("Tournament Course"));
                if (target) { target.click(); return true; }
                return false;
            });

            if (!courseFound) throw new Error("Hittade inte 'Tournament Course' i listan");

        } catch (e) {
            throw new Error(`Navigeringsfel: ${e.message}`);
        }

        // VÄLJ DATUM
        console.log("5. Väljer datum...");
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
        
        await sleep(7000);

        // KOLLA TIDER
        console.log("6. Läser av tider...");
        const available = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button, .v-card'))
                .map(el => el.innerText)
                .filter(txt => /\d{2}:\d{2}/.test(txt) && !txt.includes("Fullbokad") && !txt.includes("Ej bokningsbar"))
                .map(txt => txt.match(/\d{2}:\d{2}/)[0]);
        });

        console.log("Hittade lediga tider:", available);

        const match = available.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (match) {
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: watchConfig.email,
                subject: "TeeTime hittad! ⛳",
                html: `<h3>Tid hittad på Vasatorp!</h3><p>Det finns en ledig tid kl <b>${match}</b>.</p>`
            });
            stopEverything(`Träff! Tid hittad: ${match}`);
        } else {
            status = `Senaste koll: ${new Date().toLocaleTimeString()} (Inga tider)`;
        }

    } catch (err) {
        console.log("❌ FEL:", err.message);
        stopEverything(`Automatiskt avstängd pga fel: ${err.message}`);
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
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    stopEverything("Stoppad manuellt");
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));
app.listen(process.env.PORT || 3000);