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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
            "--disable-dev-shm-usage"
        ],
        executablePath: await chromium.executablePath(),
        headless: "new",
        protocolTimeout: 120000 // 🔥 fix timeout
    });

    const context = browser.defaultBrowserContext();

    await context.setCookie({
        name: "CookieConsent",
        value: JSON.stringify({
            stamp: "manual",
            necessary: true,
            preferences: true,
            statistics: true,
            marketing: true,
            method: "explicit",
            ver: 1,
            utc: Date.now(),
            region: "se"
        }),
        domain: "mingolf.golf.se",
        path: "/"
    });

    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
        "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });

    try {

        console.log("Going to booking page...");
        await page.goto("https://mingolf.golf.se/bokning/", {
            waitUntil: "networkidle2",
            timeout: 60000
        });

        console.log("Current URL:", page.url());

        console.log("Waiting for login...");
        await page.waitForSelector("input[type='password']", { timeout: 60000 });

        const inputs = await page.$$("input:not([type='checkbox'])");

        console.log("Typing login...");
        await inputs[0].type(watchConfig.golfId, { delay: 50 });
        await inputs[1].type(watchConfig.password, { delay: 50 });

        console.log("Submitting login...");
        await inputs[1].press("Enter");

        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});

        await sleep(5000);

        console.log("Logged in...");

        console.log("Searching club...");

        await page.waitForSelector("input", { timeout: 60000 });
        await page.type("input", "Vasatorp", { delay: 50 });

        await page.waitForSelector("li", { timeout: 60000 });

        const clubs = await page.$$("li");

        if (clubs.length > 0) {
            await clubs[0].click();
        }

        await sleep(3000);

        console.log("Selecting course...");

        await page.waitForSelector("button", { timeout: 60000 });

        const buttons = await page.$$("button");

        for (const btn of buttons) {
            const text = await page.evaluate(el => el.innerText, btn);

            if (text.includes("Park")) {
                await btn.click();
                break;
            }
        }

        await sleep(5000);

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

            status = `Bevakning klar - tid hittad: ${time}`;

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