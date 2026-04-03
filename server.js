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

let status = "Ingen aktiv bevakning";

async function sendEmail(email, time) {
    try {
        await resend.emails.send({
            from: "TeePilot <onboarding@resend.dev>",
            to: email,
            subject: "TeeTime hittad ⛳!",
            html: `<h2>TeeTime hittad!</h2><p>Tid: ${time}</p>`
        });

        console.log("Mail sent to", email);

    } catch (err) {
        console.log("Email error:", err);
    }
}

async function checkTimes() {

    console.log("checkTimes körs");
    if (!watchConfig) return;

    const browser = await puppeteer.launch({
        args: [
            ...chromium.args,
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
        ],
        executablePath: await chromium.executablePath(),
        headless: "new"
    });

    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
        });
    });

    await page.setExtraHTTPHeaders({
        "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });

    page.setDefaultNavigationTimeout(60000);

    try {

        console.log("Going to login page...");
        await page.goto("https://mingolf.golf.se/", {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        console.log("Current URL:", page.url());

        // vänta lite extra (MinGolf laddar segt)
        await page.waitForTimeout(5000);

        // DEBUG: se inputs
        const inputs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("input"))
                .map(el => ({
                    id: el.id,
                    name: el.name,
                    type: el.type,
                    placeholder: el.placeholder
                }));
        });

        console.log("Inputs found:", inputs);

        // 🔍 hitta rätt frame (om finns)
        let target = page;

        const frames = page.frames();
        console.log("Frames:", frames.map(f => f.url()));

        for (const frame of frames) {
            const hasInput = await frame.$("input");
            if (hasInput) {
                target = frame;
                console.log("Using frame:", frame.url());
                break;
            }
        }

        console.log("Typing login...");

        await target.waitForSelector("input", { timeout: 60000 });

        // testa flera selectors (failsafe)
        const usernameSelector = "input[type='text'], input[name='username']";
        const passwordSelector = "input[type='password']";

        await target.type(usernameSelector, watchConfig.golfId, { delay: 50 });
        await target.type(passwordSelector, watchConfig.password, { delay: 50 });

        console.log("Click login...");

        const loginBtn = await target.$("button[type='submit'], button");

        if (loginBtn) {
            await Promise.all([
                loginBtn.click(),
                page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {})
            ]);
        } else {
            console.log("No login button found");
        }

        console.log("Logged in maybe...");

        await page.waitForTimeout(5000);

        console.log("Going to booking...");
        await page.goto("https://mingolf.golf.se/", {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        await page.waitForTimeout(5000);

        console.log("Searching club...");
        await page.type("input", "Vasatorp");
        await page.waitForTimeout(3000);

        await page.evaluate(() => {
            const club = [...document.querySelectorAll("div")]
                .find(el => el.innerText.includes("Vasatorp"));
            if (club) club.click();
        });

        await page.waitForTimeout(3000);

        console.log("Selecting course...");
        await page.evaluate(() => {
            const course = [...document.querySelectorAll("div")]
                .find(el => el.innerText.includes("Park Course"));
            if (course) course.click();
        });

        await page.waitForTimeout(5000);

        console.log("Getting times...");
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText)
                .filter(text => text.match(/\d{2}:\d{2}/));
        });

        console.log("Times found:", times);

        const available = times.filter(t => {
            return t >= watchConfig.from && t <= watchConfig.to;
        });

        if (available.length > 0) {

            const time = available[0];

            console.log("TEE TIME FOUND:", time);

            await sendEmail(watchConfig.email, time);

            status = `Bevakning slutförd - tid hittad: ${time}`;

            job.stop();
            watchConfig = null;

        } else {
            console.log("No times in range");
        }

    } catch (err) {
        console.log("Error:", err);
    }

    await browser.close();
}

app.post("/start", (req, res) => {

    watchConfig = req.body;
    status = "Bevakning aktiv";

    console.log("Watch started:", watchConfig);

    if (job) job.stop();

    checkTimes();
    job = cron.schedule("*/15 * * * *", checkTimes);

    res.sendStatus(200);
});

app.post("/stop", (req, res) => {

    if (job) job.stop();

    watchConfig = null;
    status = "Bevakning stoppad";

    console.log("Watch stopped");

    res.sendStatus(200);
});

app.get("/status", (req, res) => {
    res.json({ status });
});

app.get("/", (req, res) => {
    res.send("Servern funkar");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});