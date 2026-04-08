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

// Enkel hemsida för att se status direkt i webbläsaren
app.get("/", (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>⛳ TeePilot Server is Online</h1>
            <p>Status: <strong>${status}</strong></p>
            ${watchConfig ? `<p>Bevakar just nu: ${watchConfig.date} (${watchConfig.from}-${watchConfig.to})</p>` : ''}
            <hr style="width: 50%; margin: 20px auto;">
            <p style="color: gray; font-size: 0.8em;">Körs på Render Free Tier</p>
        </div>
    `);
});

async function checkTimes() {
    if (!watchConfig) return;

    let browser = null;
    try {
        console.log(`[${new Date().toLocaleTimeString()}] Påbörjar sökning för ${watchConfig.date}...`);
        status = "Startar webbläsare...";

        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                "--disable-setuid-sandbox",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process" // Sparar RAM på Render
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        // OPTIMERING: Blockera tunga filer (bilder/CSS) så Render orkar med
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Sätt en lång timeout (60 sek) för sega laddningstider
        page.setDefaultNavigationTimeout(60000);

        // STEG 1: Logga in
        status = "Laddar inloggning...";
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });

        // Vänta på att inloggningsfältet faktiskt dyker upp
        await page.waitForSelector("#LoginId", { visible: true, timeout: 30000 });

        status = "Fyller i uppgifter...";
        await page.type("#LoginId", watchConfig.golfId, { delay: 50 });
        await page.type("#Password", watchConfig.password, { delay: 50 });
        
        status = "Skickar inloggning...";
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: "networkidle2" }),
        ]);

        // Kontrollera om vi lyckades logga in genom att kolla URL
        if (page.url().includes("Login")) {
            throw new Error("Inloggning misslyckades - kontrollera Golf-ID/Lösenord!");
        }

        console.log("Inloggning godkänd!");
        status = "Navigerar till Vasatorp...";

        // STEG 2: Gå till bokningssidan (Tournament Course)
        const url = `https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`;
        await page.goto(url, { waitUntil: "networkidle2" });

        // Vänta på att tabellen med tider laddas
        status = "Läser av tider...";
        await page.waitForSelector('.booking-slot', { timeout: 30000 });

        // STEG 3: Analysera tiderna
        const slots = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.booking-slot'));
            return items.map(item => {
                const timeText = item.querySelector('.time')?.innerText || "";
                // En tid är ledig om den inte har 'occupied' eller 'disabled' klasser
                const isAvailable = !item.classList.contains('occupied') && !item.classList.contains('disabled');
                return { time: timeText, available: isAvailable };
            });
        });

        const match = slots.find(s => s.available && s.time >= watchConfig.from && s.time <= watchConfig.to);

        if (match) {
            console.log("BOOM! Hittade tid:", match.time);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TEE TIME HITTAD!",
                html: `<h1>Tid hittad på Vasatorp!</h1><p>Det finns en ledig tid kl <strong>${match.time}</strong> den ${watchConfig.date}.</p><p>Gå till Min Golf och boka direkt!</p>`
            });
            stopJob();
            status = `Tid hittad: ${match.time}. Mail skickat!`;
        } else {
            console.log("Ingen ledig tid i intervallet ännu.");
            status = "Bevakning aktiv: Letar vidare...";
        }

    } catch (err) {
        console.error("Körningsfel:", err.message);
        status = "Försöker igen om 3 min (Fel: " + err.message + ")";
    } finally {
        if (browser) {
            await browser.close();
            console.log("Webbläsare stängd för att spara minne.");
        }
    }
}

function stopJob() {
    if (job) job.stop();
    watchConfig = null;
    status = "Ingen aktiv bevakning";
}

// ENDPOINTS FÖR FRONTEND
app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad";
    console.log("Bevakning startad för:", watchConfig.golfId);
    
    if (job) job.stop();
    
    // Kör första kollen direkt
    checkTimes();
    
    // Kör var 3:e minut (standard för att hålla Render vid liv utan krasch)
    job = cron.schedule("*/3 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    stopJob();
    console.log("Bevakning stoppad manuellt.");
    res.sendStatus(200);
});

app.get("/status", (req, res) => {
    res.json({ status });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server körs på port ${PORT}`));