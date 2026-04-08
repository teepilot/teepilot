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

// Startsida för att bekräfta att servern lever
app.get("/", (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>⛳ TeePilot Server is Online</h1>
            <p>Status: <strong>${status}</strong></p>
            ${watchConfig ? `<p>Bevakar: ${watchConfig.date} (${watchConfig.from}-${watchConfig.to})</p>` : ''}
        </div>
    `);
});

async function checkTimes() {
    if (!watchConfig) return;

    let browser = null;
    try {
        console.log(`[${new Date().toLocaleTimeString()}] Startar koll för ${watchConfig.date}...`);
        status = "Startar webbläsare...";

        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                "--disable-setuid-sandbox",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        // OPTIMERING: Blockera onödiga resurser för att spara RAM och tid
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Generös timeout för Renders långsamma processer
        page.setDefaultNavigationTimeout(60000);

        // 1. Logga in
        status = "Loggar in på Min Golf...";
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });

        await page.type("#LoginId", watchConfig.golfId);
        await page.type("#Password", watchConfig.password);
        
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: "networkidle2" }),
        ]);

        // 2. Gå till bokningssidan
        status = "Söker efter tider...";
        // Tournament Course på Vasatorp
        const url = `https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`;
        await page.goto(url, { waitUntil: "networkidle2" });

        // 3. Leta efter tids-slots
        await page.waitForSelector('.booking-slot', { timeout: 30000 });

        const slots = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.booking-slot'));
            return items.map(item => {
                const timeText = item.querySelector('.time')?.innerText || "";
                // En tid är ledig om den inte har klassen 'occupied' eller 'disabled'
                const isAvailable = !item.classList.contains('occupied') && !item.classList.contains('disabled');
                return { time: timeText, available: isAvailable };
            });
        });

        const match = slots.find(s => s.available && s.time >= watchConfig.from && s.time <= watchConfig.to);

        if (match) {
            console.log("MATCH FUNNEN:", match.time);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TEE TIME HITTAD!",
                html: `<h1>Tid hittad!</h1><p>En ledig tid kl <strong>${match.time}</strong> finns nu på Vasatorp!</p>`
            });
            stopJob();
            status = `Hittad: ${match.time}. Mail skickat!`;
        } else {
            console.log("Inga lediga tider matchade intervallet.");
            status = "Bevakning aktiv: Letar tider...";
        }

    } catch (err) {
        console.error("Fel vid körning:", err.message);
        status = "Väntar på nästa försök (Sidan segade ner)...";
    } finally {
        if (browser) {
            await browser.close();
            console.log("Webbläsare stängd.");
        }
    }
}

function stopJob() {
    if (job) job.stop();
    watchConfig = null;
    status = "Ingen aktiv bevakning";
}

// ENDPOINTS
app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad";
    console.log("Bevakning startad för:", watchConfig.golfId);
    
    if (job) job.stop();
    
    // Kör första gången direkt
    checkTimes();
    
    // Kör var 3:e minut (för att inte överbelasta Render)
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
app.listen(PORT, () => console.log(`Server kör på port ${PORT}`));