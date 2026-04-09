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

app.get("/", (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>⛳ TeePilot Server Status</h1>
            <p>Status: <strong>${status}</strong></p>
            ${watchConfig ? `<p>Bevakar: ${watchConfig.date} (${watchConfig.from}-${watchConfig.to})</p>` : ''}
        </div>
    `);
});

async function checkTimes() {
    if (!watchConfig) return;
    let browser = null;

    try {
        console.log(`--- [${new Date().toLocaleTimeString()}] Startar ny söksekvens ---`);
        status = "Startar webbläsare...";
        
        browser = await puppeteer.launch({
            args: [
                ...chromium.args, 
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox"
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        page.setDefaultNavigationTimeout(60000);

        // 1. GÅ TILL LOGIN
        console.log("[STEP 1] Navigerar till inloggningssidan...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "networkidle2" });

        // Hantera Cookies
        try {
            const cookieBtn = "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll";
            await page.waitForSelector(cookieBtn, { timeout: 5000 });
            await page.click(cookieBtn);
            console.log("[LOG] Cookie-banner bortklickad.");
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.log("[LOG] Ingen cookie-banner dök upp.");
        }

        // Identifiera fält och skriv in uppgifter
        console.log("[STEP 2] Identifierar inloggningsfält...");
        await page.waitForSelector("input[type='password']", { timeout: 15000 });
        
        const inputs = await page.$$("input");
        for (const input of inputs) {
            const type = await page.evaluate(el => el.type, input);
            if (type === "text" || type === "email") await input.type(watchConfig.golfId);
            if (type === "password") await input.type(watchConfig.password);
        }

        console.log("[STEP 3] Klickar på Logga in...");
        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => console.log("Navigering tog tid, fortsätter ändå..."))
        ]);

        // VERIFIERA INLOGGNING
        const currentUrl = page.url();
        if (currentUrl.includes("Login")) {
            console.error("[ERROR] Inloggning misslyckades. Fortfarande kvar på login-sidan.");
            throw new Error("Inloggning nekad (fel uppgifter?)");
        } else {
            console.log("[SUCCESS] Inloggning genomförd! Nuvarande URL:", currentUrl);
        }

        // 2. GÅ TILL BOKNINGEN
        const bookingUrl = `https://mingolf.golf.se/bokning/0abbcc77-25a8-4167-83c7-bbf43d6e863c/${watchConfig.date}`;
        console.log(`[STEP 4] Navigerar till bokningssidan: ${bookingUrl}`);
        status = "Letar tider...";
        
        await page.goto(bookingUrl, { waitUntil: "networkidle2" });

        // Vänta på tiderna
        console.log("[STEP 5] Väntar på att tidsschemat ska renderas...");
        await page.waitForSelector("button", { timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000)); // Ge sidan tid att rita ut alla knappar

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        if (times.length > 0) {
            console.log(`[INFO] Hittade totalt ${times.length} bokningsbara tider på sidan.`);
            console.log("Alla hittade tider:", times.join(", "));
        } else {
            console.log("[WARN] Inga tid-knappar hittades på sidan. Sidan kan vara tom.");
        }
        
        const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available) {
            console.log(`[MATCH] BINGO! Hittade en tid kl ${available} inom intervallet.`);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TeeTime hittad ⛳!",
                html: `<h2>Tid hittad: ${available}</h2><p>Datum: ${watchConfig.date}</p><p>Skynda dig in och boka på Min Golf!</p>`
            });
            console.log("[LOG] E-post skickad till:", watchConfig.email);
            status = `Hittad: ${available}. Bevakning avslutad.`;
            stopJob();
        } else {
            console.log(`[INFO] Ingen tid matchade intervallet ${watchConfig.from}-${watchConfig.to}.`);
            status = `Senaste sökning: ${new Date().toLocaleTimeString()} (Inga lediga än)`;
        }

    } catch (err) {
        console.error(`[CRITICAL ERROR] ${err.message}`);
        status = "Fel vid körning: " + err.message;
    } finally {
        if (browser) {
            await browser.close();
            console.log("[STEP 6] Webbläsare stängd.");
            console.log("-----------------------------------------------");
        }
    }
}

function stopJob() {
    if (job) job.stop();
    watchConfig = null;
}

app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad";
    console.log("Startar bevakning för:", watchConfig.golfId);
    
    if (job) job.stop();
    checkTimes(); // Kör direkt en gång
    job = cron.schedule("*/5 * * * *", checkTimes); // Kör var 5:e minut
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    stopJob();
    status = "Ingen aktiv bevakning";
    console.log("Bevakning stoppad manuellt.");
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server körs på port ${PORT}`));