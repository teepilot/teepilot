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
let activeBrowser = null; // Håller koll på webbläsaren globalt för att kunna stänga den direkt

app.get("/", (req, res) => {
    res.send(`<h1>TeePilot Status</h1><p>Status: ${status}</p>`);
});

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
        });

        const page = await activeBrowser.newPage();
        
        // --- OPTIMERING: Blockera bilder och CSS för att snabba upp laddningen ---
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // Öka timeout till 60 sekunder för sega servrar
        page.setDefaultNavigationTimeout(60000);

        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });

        // Vänta på lösenordsfältet (istället för hela sidan)
        console.log("[LOG] Väntar på inmatningsfält...");
        await page.waitForSelector("input[type='password']", { timeout: 40000 });

        const inputs = await page.$$("input");
        for (const input of inputs) {
            const type = await page.evaluate(el => el.type, input);
            if (type === "text" || type === "email") await input.type(watchConfig.golfId);
            if (type === "password") await input.type(watchConfig.password);
        }

        console.log("[LOG] Skickar inloggning...");
        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => console.log("Navigering tog tid, men fortsätter..."))
        ]);

        const bookingUrl = `https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`;
        console.log("[LOG] Går till bokningssida...");
        await page.goto(bookingUrl, { waitUntil: "domcontentloaded" });

        await page.waitForSelector("button", { timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        console.log("[INFO] Tider funna:", times.join(", "));
        const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available) {
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TeeTime hittad ⛳!",
                html: `<h2>Tid hittad: ${available}</h2>`
            });
            status = `Träff! Tid: ${available}`;
            stopEverything();
        } else {
            status = `Senaste koll: ${new Date().toLocaleTimeString()} (Inga lediga)`;
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Timeout/Fel vid sökning, försöker igen snart...";
    } finally {
        if (activeBrowser) {
            await activeBrowser.close();
            activeBrowser = null;
        }
        isSearching = false;
        console.log("-----------------------------------------------");
    }
}

// Funktion för att verkligen stänga ner allt
async function stopEverything() {
    console.log("Stoppar all bevakning och stänger webbläsare...");
    
    if (job) {
        job.stop();
        job = null;
    }
    
    watchConfig = null;
    status = "Ingen aktiv bevakning";

    if (activeBrowser) {
        try {
            await activeBrowser.close();
        } catch (e) {
            console.log("Webbläsaren var redan stängd.");
        }
        activeBrowser = null;
    }
    isSearching = false;
}

app.post("/start", async (req, res) => {
    // Om något redan körs, stäng ner det först
    await stopEverything();
    
    watchConfig = req.body;
    status = "Bevakning startad";
    console.log("Startar bevakning för:", watchConfig.golfId);
    
    // Kör direkt
    checkTimes();
    
    // Starta schemat
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server redo på port ${PORT}`));