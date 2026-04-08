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

// Startsida så du slipper "Cannot GET /"
app.get("/", (req, res) => {
    res.send("<h1>TeePilot Server is Online</h1><p>Status: " + status + "</p>");
});

async function checkTimes() {
    if (!watchConfig) return;

    let browser = null;
    try {
        console.log(`Startar webbläsare för att kolla ${watchConfig.date}...`);
        status = "Loggar in på Min Golf...";

        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        // Gå till inloggning
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "networkidle2" });

        // Logga in (Här används dina uppgifter från formuläret)
        await page.type("#LoginId", watchConfig.golfId);
        await page.type("#Password", watchConfig.password);
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: "networkidle2" });

        console.log("Inloggad! Letar tider...");

        // Gå direkt till bokningssidan för rätt datum och bana
        // Tournament Course = 0abbcc77-25a8-4167-83c7-bbf43d6e863c
        const url = `https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`;
        await page.goto(url, { waitUntil: "networkidle2" });

        // Vänta på att tiderna laddas (vi letar efter tids-element)
        await page.waitForSelector('.booking-slot', { timeout: 10000 });

        // Hämta alla tider
        const slots = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.booking-slot'));
            return items.map(item => {
                const timeText = item.querySelector('.time')?.innerText || "";
                const isAvailable = !item.classList.contains('occupied');
                return { time: timeText, available: isAvailable };
            });
        });

        const match = slots.find(s => s.available && s.time >= watchConfig.from && s.time <= watchConfig.to);

        if (match) {
            console.log("TID HITTAD:", match.time);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TEE TIME HITTAD!",
                html: `<h1>Tid hittad!</h1><p>En ledig tid kl <strong>${match.time}</strong> finns nu på Vasatorp!</p>`
            });
            stopJob();
            status = `Tid hittad: ${match.time}. Mail skickat!`;
        } else {
            console.log("Inga tider matchade intervallet just nu.");
            status = "Bevakning aktiv: Letar tider...";
        }

    } catch (err) {
        console.error("Puppeteer-fel:", err.message);
        // Vi stoppar inte jobbet vid tillfälliga fel, vi försöker igen nästa gång
        status = "Väntar på nästa försök...";
    } finally {
        if (browser) await browser.close();
    }
}

function stopJob() {
    if (job) job.stop();
    watchConfig = null;
}

app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad";
    console.log("Startar för:", watchConfig.golfId);
    
    if (job) job.stop();
    checkTimes(); // Kör direkt
    
    // VIKTIGT: Kör var 3:e minut för att inte krascha Render Free Tier
    job = cron.schedule("*/3 * * * *", checkTimes); 
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    stopJob();
    status = "Bevakning stoppad";
    res.sendStatus(200);
});

app.get("/status", (req, res) => {
    res.json({ status });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kör på port ${PORT}`));