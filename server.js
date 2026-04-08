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

// Startsida
app.get("/", (req, res) => {
    res.send(`<h1>TeePilot Online</h1><p>Status: ${status}</p>`);
});

async function checkTimes() {
    if (!watchConfig) return;

    let browser = null;
    try {
        console.log(`[${new Date().toLocaleTimeString()}] Kollar tider för ${watchConfig.golfId}...`);
        status = "Startar sökning...";

        browser = await puppeteer.launch({
            args: [...chromium.args, "--disable-gpu", "--disable-dev-shm-usage", "--single-process"],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        // Optimering: Skippa tunga bilder
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        page.setDefaultNavigationTimeout(60000);

        // 1. Gå till Min Golf och logga in (Använder dina gamla fungerande ID:n!)
        await page.goto("https://mingolf.golf.se/", { waitUntil: "domcontentloaded" });
        
        // Vänta på #username (från din gamla kod)
        await page.waitForSelector("#username", { timeout: 30000 });
        
        await page.type("#username", watchConfig.golfId);
        await page.type("#password", watchConfig.password);
        
        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: "networkidle2" })
        ]);

        console.log("Inloggad!");

        // 2. Gå direkt till Vasatorps Tournament Course (Här använder vi direkt-länken för att spara RAM)
        const bookingUrl = `https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`;
        await page.goto(bookingUrl, { waitUntil: "networkidle2" });

        // Vänta på knapparna (tiderna)
        await page.waitForSelector("button", { timeout: 20000 });

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText)
                .filter(text => text.match(/\d{2}:\d{2}/));
        });

        console.log("Hittade tider:", times);

        const available = times.filter(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available.length > 0) {
            const time = available[0];
            console.log("TEE TIME FOUND:", time);

            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TeeTime hittad ⛳!",
                html: `<h2>Tid hittad!</h2><p>Tid: ${time} den ${watchConfig.date}</p>`
            });

            status = `Hittad: ${time}. Mail skickat!`;
            if (job) job.stop();
            watchConfig = null;
        } else {
            status = "Söker (Inga lediga tider än)...";
        }

    } catch (err) {
        console.error("Fel:", err.message);
        status = "Väntar på nästa försök...";
    } finally {
        if (browser) await browser.close();
    }
}

app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad";
    if (job) job.stop();
    checkTimes();
    // Kör var 5:e minut (lugnare för Render)
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    if (job) job.stop();
    watchConfig = null;
    status = "Stoppad";
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server online!"));