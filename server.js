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
let activeBrowser = null;

app.get("/", (req, res) => {
    res.send(`<h1>TeePilot Status</h1><p>Status: ${status}</p>`);
});

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`--- [${new Date().toLocaleTimeString()}] Startar söksekvens ---`);
        status = "Sökning pågår...";

        activeBrowser = await puppeteer.launch({
            args: [...chromium.args, "--disable-blink-features=AutomationControlled", "--single-process"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await activeBrowser.newPage();
        
        // Snabbhets-optimering
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        page.setDefaultNavigationTimeout(60000);

        // 1. LOGIN-STEG
        console.log("[STEP 1] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });

        // Cookie-check (viktigt för att inte blockera skärmen)
        try {
            await page.waitForSelector("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", { timeout: 5000 });
            await page.click("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll");
            console.log("[LOG] Cookies accepterade.");
        } catch (e) {
            console.log("[LOG] Ingen cookie-banner hittad.");
        }

        console.log("[STEP 2] Fyller i inloggningsuppgifter...");
        await page.waitForSelector("input[type='password']", { timeout: 20000 });
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

        // 2. NAVIGERING & BANVAL
        console.log("[STEP 3] Navigerar till bokningssidan...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });
        
        // Vänta på att Vasatorp-vyn laddas (din standardinställning)
        console.log("[STEP 4] Letar efter Tournament Course...");
        await new Promise(r => setTimeout(r, 5000)); 

        const clickResult = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll("div, span, p, button, li"));
            const target = elements.find(el => el.innerText && el.innerText.includes("Tournament Course"));
            if (target) {
                target.click();
                return "KLICKAD";
            }
            return "HITTADES EJ";
        });

        console.log(`[LOG] Banval-status: ${clickResult}`);
        await new Promise(r => setTimeout(r, 3000)); // Vänta på att tiderna ritas ut

        // 3. SÖK TIDER
        console.log("[STEP 5] Skannar tider...");
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        if (times.length > 0) {
            console.log(`[INFO] Hittade tider: ${times.join(", ")}`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

            if (available) {
                console.log(`[MATCH] BINGO! Tid hittad: ${available}`);
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "TeeTime hittad ⛳!",
                    html: `<h2>Tid hittad: ${available}</h2><p>Bana: Tournament Course</p><p>Datum: ${watchConfig.date}</p>`
                });
                status = `Träff! Tid: ${available}`;
                await stopEverything();
            } else {
                status = `Sökt kl ${new Date().toLocaleTimeString()} (Ingen ledig än)`;
            }
        } else {
            console.log("[ERROR] Inga tidsknappar synliga på sidan.");
            status = "Kunde inte hitta tider (Banval misslyckades?)";
        }

    } catch (err) {
        console.error(`[CRITICAL] ${err.message}`);
        status = "Fel vid sökning: " + err.message;
    } finally {
        if (activeBrowser) {
            await activeBrowser.close();
            activeBrowser = null;
        }
        isSearching = false;
        console.log("-----------------------------------------------");
    }
}

async function stopEverything() {
    console.log("[STOP] Stänger ner all bevakning...");
    if (job) { job.stop(); job = null; }
    watchConfig = null;
    status = "Ingen aktiv bevakning";
    if (activeBrowser) {
        try { await activeBrowser.close(); } catch (e) {}
        activeBrowser = null;
    }
    isSearching = false;
}

app.post("/start", async (req, res) => {
    await stopEverything();
    watchConfig = req.body;
    status = "Bevakning startad";
    console.log("Startar bevakning för:", watchConfig.golfId);
    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server online på port ${PORT}`));