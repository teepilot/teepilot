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
        console.log(`[${new Date().toLocaleTimeString()}] Startar sökning för ${watchConfig.golfId}...`);
        status = "Öppnar webbläsare...";

        browser = await puppeteer.launch({
            args: [...chromium.args, "--disable-gpu", "--disable-dev-shm-usage", "--single-process"],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        page.setDefaultNavigationTimeout(90000);

        // 1. Gå direkt till inloggningssidan istället för roten
        status = "Laddar inloggning...";
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "networkidle2" });

        // Försök hitta antingen #username eller vänta lite extra
        try {
            await page.waitForSelector("#username", { visible: true, timeout: 45000 });
        } catch (e) {
            console.log("Hittade inte #username direkt, testar att ladda om...");
            await page.reload({ waitUntil: "networkidle2" });
            await page.waitForSelector("#username", { visible: true, timeout: 30000 });
        }
        
        status = "Fyller i uppgifter...";
        await page.type("#username", watchConfig.golfId, { delay: 50 });
        await page.type("#password", watchConfig.password, { delay: 50 });
        
        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: "networkidle2" })
        ]);

        // 2. Gå till bokningen
        status = "Letar tider...";
        const bookingUrl = `https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`;
        await page.goto(bookingUrl, { waitUntil: "networkidle2" });

        // Vänta på att knapparna med tider laddas
        await page.waitForSelector("button", { timeout: 30000 });

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText)
                .filter(text => text.match(/\d{2}:\d{2}/));
        });

        console.log("Tider funna:", times);
        const available = times.filter(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available.length > 0) {
            const time = available[0];
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TeeTime hittad ⛳!",
                html: `<h2>Tid hittad: ${time}</h2><p>Datum: ${watchConfig.date}</p>`
            });
            status = `Träff! ${time} mailat.`;
            if (job) job.stop();
            watchConfig = null;
        } else {
            status = "Söker (Inga lediga tider än)...";
        }

    } catch (err) {
        console.error("Fel:", err.message);
        status = "Försök misslyckades, väntar på nästa...";
    } finally {
        if (browser) await browser.close();
        console.log("Webbläsare stängd.");
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