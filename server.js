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

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`--- [${new Date().toLocaleTimeString()}] Startar sökning ---`);
        status = "Sökning pågår...";

        activeBrowser = await puppeteer.launch({
            args: [...chromium.args, "--disable-blink-features=AutomationControlled", "--single-process"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            defaultViewport: { width: 1280, height: 800 } // Sätt en fast storlek för mus-simulering
        });

        const page = await activeBrowser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // 1. LOGIN (Din stabila metod)
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("input[type='password']", { timeout: 30000 });

        const inputs = await page.$$("input");
        for (const input of inputs) {
            const type = await page.evaluate(el => el.type, input);
            if (type === "text" || type === "email") await input.type(watchConfig.golfId);
            if (type === "password") await input.type(watchConfig.password);
        }

        console.log("[LOG] Skickar inloggning...");
        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {})
        ]);

        // 2. BOKNINGSSIDA
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });
        await new Promise(r => setTimeout(r, 6000)); 

        // 3. DATUMVAL (Mus-simulering)
        const dayToPick = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Klickar på datum: ${dayToPick}...`);
        
        const dateSelector = await page.evaluateHandle((day) => {
            const btns = Array.from(document.querySelectorAll("button, .v-btn__content, span"));
            return btns.find(el => el.innerText && el.innerText.trim() === day);
        }, dayToPick);

        if (dateSelector.asElement()) {
            await dateSelector.asElement().click(); // Puppeteer försöker klicka "fysiskt" här
            await new Promise(r => setTimeout(r, 3000));
        }

        // 4. VÄLJ BANA (Tournament Course - Mus-simulering)
        console.log("[LOG] Väljer Tournament Course...");
        const courseSelector = await page.evaluateHandle(() => {
            const elements = Array.from(document.querySelectorAll("div, span, button, p"));
            return elements.find(e => e.innerText && e.innerText.includes("Tournament Course"));
        });

        if (courseSelector.asElement()) {
            const element = courseSelector.asElement();
            await element.hover(); // Hovra först för att trigga eventuella skript
            await new Promise(r => setTimeout(r, 500));
            await element.click();
            console.log("[LOG] Ban-klick utfört.");
        }

        // 5. VÄNTA PÅ INNEHÅLL (Tidsknappar)
        console.log("[LOG] Väntar på att tider ska dyka upp...");
        try {
            // Vänta max 15 sekunder på att en knapp med text formatet 00:00 ska dyka upp
            await page.waitForFunction(() => {
                const buttons = Array.from(document.querySelectorAll("button"));
                return buttons.some(btn => btn.innerText.trim().match(/^\d{2}:\d{2}$/));
            }, { timeout: 15000 });
            console.log("[LOG] Tider identifierade på sidan!");
        } catch (e) {
            console.log("[WARN] Timeout: Inga tidsknappar dök upp.");
        }

        // 6. LÄS TIDER
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
                html: `<h2>Tid hittad: ${available}</h2><p>Datum: ${watchConfig.date}</p>`
            });
            status = `Träff! ${available}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()} (Inga lediga)`;
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Fel vid sökning...";
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
    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

app.listen(process.env.PORT || 3000, () => console.log("Server online!"));