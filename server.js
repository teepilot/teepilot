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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 🔥 FÖRBÄTTRAD KLICK-FUNKTION
async function clickByText(page, match) {
    try {
        // Vänta tills elementet faktiskt finns i DOM:en
        await page.waitForFunction(
            (text) => {
                const elements = Array.from(document.querySelectorAll("div, button, span, a, li"));
                return elements.some(el => el.innerText.toLowerCase().includes(text.toLowerCase()));
            },
            { timeout: 10000 },
            match
        );

        // Utför klicket direkt i webbläsarkontexten för att ignorera overlays
        const clicked = await page.evaluate((text) => {
            const elements = Array.from(document.querySelectorAll("div, button, span, a, li"));
            const el = elements.find(e => e.innerText.toLowerCase().includes(text.toLowerCase()));
            if (el) {
                el.scrollIntoView();
                el.click(); // "Force click"
                return true;
            }
            return false;
        }, match);

        if (clicked) console.log(`Klickade på: "${match}"`);
        return clicked;
    } catch (err) {
        console.log(`Misslyckades att klicka på: "${match}"`);
        return false;
    }
}

async function sendEmail(email, time) {
    try {
        await resend.emails.send({
            from: "TeePilot <onboarding@resend.dev>",
            to: email,
            subject: "TeeTime hittad ⛳",
            html: `<h2>TeeTime hittad!</h2><p>En tid har hittats: ${time}</p>`
        });
    } catch (err) {
        console.log("Mail error:", err);
    }
}

async function checkTimes() {
    if (isRunning) {
        console.log("Skipping - körning pågår redan");
        return;
    }

    if (!watchConfig) return;

    isRunning = true;
    console.log("Startar sökning...");

    let browser;

    try {
        browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
            executablePath: await chromium.executablePath(),
            headless: true
        });

        const page = await browser.newPage();
        await page.setDefaultTimeout(60000);

        console.log("Öppnar Min Golf...");
        await page.goto("https://mingolf.golf.se/bokning/#/", {
            waitUntil: "networkidle2"
        });

        await sleep(5000);

        // 1. LOGIN
        const inputs = await page.$$("input");
        if (inputs.length >= 2) {
            console.log("Loggar in...");
            await inputs[0].type(watchConfig.golfId, { delay: 50 });
            await inputs[1].type(watchConfig.password, { delay: 50 });
            await inputs[1].press("Enter");
            await sleep(8000);
        }

        // 2. COOKIES (Aggressiv hantering)
        console.log("Hanterar cookies...");
        const cookieButtons = ["acceptera alla", "godkänn alla", "acceptera", "ok"];
        for (const btn of cookieButtons) {
            const success = await clickByText(page, btn);
            if (success) break;
        }
        
        // Tvinga bort eventuella overlays som blockerar klick
        await page.evaluate(() => {
            const overlays = document.querySelectorAll('[id*="sp_message"], [class*="cookie"], [class*="modal"]');
            overlays.forEach(el => el.remove());
            document.body.style.overflow = 'auto';
        });

        await sleep(2000);

        // 3. NAVIGERING
        console.log("Öppnar klubbväljaren...");
        const opened = await clickByText(page, "klubb och bana");
        if (!opened) throw new Error("Kunde inte öppna klubb/bana-menyn");

        await sleep(3000);
        await clickByText(page, "tournament"); // Vasatorp Tournament Course
        await sleep(3000);

        // 4. DATUM
        console.log("Väljer datum...");
        await clickByText(page, "när vill du spela");
        await sleep(2000);
        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); // Tar bort nollor, t.ex "05" blir "5"
        await clickByText(page, day);
        await sleep(4000);

        // 5. KONTROLLERA TIDER
        console.log("Hämtar tillgängliga tider...");
        const times = await page.evaluate(() =>
            Array.from(document.querySelectorAll("button, div"))
                .map(el => el.innerText.trim())
                .filter(t => /^\d{2}:\d{2}$/.test(t))
        );

        const available = times.filter(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available.length > 0) {
            const foundTime = available[0];
            console.log("TRÄFF! Hittade tid:", foundTime);
            await sendEmail(watchConfig.email, foundTime);
            status = `Tid hittad: ${foundTime}`;
            if (job) job.stop();
            watchConfig = null;
        } else {
            console.log("Inga tider hittade just nu.");
            status = `Bevakning aktiv (Senast kollad ${new RegExp(/\d{2}:\d{2}/).exec(new Date().toString())})`;
        }

    } catch (err) {
        console.log("Ett fel uppstod:", err.message);
    } finally {
        if (browser) await browser.close();
        isRunning = false;
    }
}

// API ROUTES
app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad...";
    console.log("Ny bevakning konfigurerad:", watchConfig);

    if (job) job.stop();
    
    // Kör direkt en gång, sen var 5:e minut
    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);

    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    if (job) job.stop();
    watchConfig = null;
    status = "Ingen aktiv bevakning";
    console.log("Bevakning stoppad manuellt.");
    res.sendStatus(200);
});

app.get("/status", (req, res) => {
    res.json({ status });
});

app.get("/", (req, res) => res.send("TeePilot Server is online"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server redo på port", PORT));