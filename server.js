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

app.get("/", (req, res) => res.send(`<h1>TeePilot Active</h1><p>Status: ${status}</p>`));

async function checkTimes() {
    if (!watchConfig) return;
    let browser = null;

    try {
        console.log("Startar sökning...");
        browser = await puppeteer.launch({
            args: [...chromium.args, "--disable-blink-features=AutomationControlled"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        page.setDefaultNavigationTimeout(60000);

        // 1. Gå till Min Golf
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "networkidle2" });

        // 🍪 COOKIE-FIX: Vänta på och klicka bort cookie-bannern om den finns
        try {
            const cookieBtn = "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll";
            await page.waitForSelector(cookieBtn, { timeout: 5000 });
            await page.click(cookieBtn);
            console.log("Cookies accepterade");
            await new Promise(r => setTimeout(r, 2000)); // Vänta på att bannern försvinner
        } catch (e) {
            console.log("Ingen cookie-banner hittad, går vidare.");
        }

        // 🔍 LOGIN-FIX: Hitta fälten via typ istället för ID
        status = "Loggar in...";
        await page.waitForSelector("input[type='password']", { timeout: 10000 });
        
        // Vi letar efter alla inputs och mappar dem
        const inputs = await page.$$("input");
        for (const input of inputs) {
            const type = await page.evaluate(el => el.type, input);
            if (type === "text" || type === "email") await input.type(watchConfig.golfId);
            if (type === "password") await input.type(watchConfig.password);
        }

        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {})
        ]);

        // ⛳ BOKNING: Gå direkt till banan för att spara tid/minne
        status = "Letar tider...";
        await page.goto(`https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`, { waitUntil: "networkidle2" });

        // Hämta alla tids-knappar
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText)
                .filter(text => text.match(/\d{2}:\d{2}/));
        });

        console.log("Hittade tider:", times);
        const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available) {
            console.log("BINGO! Tid hittad:", available);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TeeTime hittad ⛳!",
                html: `<h2>Tid hittad: ${available}</h2><p>Boka snabbt på Min Golf!</p>`
            });
            status = `Hittad: ${available}`;
            if (job) job.stop();
            watchConfig = null;
        } else {
            status = "Söker... (Ingen ledig än)";
        }

    } catch (err) {
        console.error("Fel:", err.message);
        status = "Försök misslyckades...";
    } finally {
        if (browser) await browser.close();
    }
}

app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning aktiv";
    if (job) job.stop();
    checkTimes();
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

app.listen(process.env.PORT || 3000, () => console.log("Server redo!"));