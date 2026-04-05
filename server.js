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

    if (isRunning) {
        console.log("Skipping - already running");
        return;
    }

    isRunning = true;
    console.log("checkTimes körs");

    if (!watchConfig) {
        isRunning = false;
        return;
    }

    let browser;

    try {

        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-zygote",
                "--single-process",
                "--disable-extensions"
            ],
            executablePath: await chromium.executablePath(),
            headless: "new",
            protocolTimeout: 120000
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

        // 🔥 blocka onödigt
        await page.setRequestInterception(true);
        page.on("request", (req) => {
            const type = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setExtraHTTPHeaders({
            "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        });

        console.log("Going to booking page...");
        await page.goto("https://mingolf.golf.se/bokning/", {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        console.log("Current URL:", page.url());

        // 🔐 LOGIN
        console.log("Waiting for login...");
        await page.waitForSelector("input[type='password']", { timeout: 60000 });

        const inputs = await page.$$("input:not([type='checkbox'])");

        console.log("Typing login...");
        await inputs[0].type(watchConfig.golfId, { delay: 30 });
        await inputs[1].type(watchConfig.password, { delay: 30 });

        console.log("Submitting login...");
        await inputs[1].press("Enter");

        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        console.log("Logged in...");
        await sleep(2000);

        // 🔍 KLUBB
        console.log("Searching club...");
        await page.waitForSelector("input", { timeout: 60000 });
        await page.type("input", "Vasatorp", { delay: 30 });

        await page.waitForSelector("li", { timeout: 60000 });

        const clubs = await page.$$("li");
        if (clubs.length > 0) await clubs[0].click();

        await sleep(2000);

        // ⛳ BANA
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

        await sleep(3000);

        // 📅 DATUM (🔥 NY FIX)
        console.log("Selecting date...");

        const allButtons = await page.$$("button");

        for (const btn of allButtons) {
            const text = await page.evaluate(el => el.innerText, btn);

            if (text.includes(watchConfig.date.split("-")[2])) {
                await btn.click();
                break;
            }
        }

        await sleep(3000);

        // 🕒 TIDER (🔥 NY FIX)
        console.log("Getting times...");

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("*"))
                .map(el => el.innerText)
                .filter(text => /^\d{2}:\d{2}$/.test(text));
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

            if (job) job.stop();
            watchConfig = null;
        }

    } catch (err) {
        console.log("Error:", err);
    }

    if (browser) {
        try {
            await browser.close();
        } catch {}
    }

    isRunning = false;
}

// 🚀 START
app.post("/start", (req, res) => {

    watchConfig = req.body;
    status = "Bevakning aktiv";

    console.log("Watch started:", watchConfig);

    if (job) job.stop();

    checkTimes();

    // 🔥 kör var 5 min (inte för ofta)
    job = cron.schedule("*/5 * * * *", checkTimes);

    res.sendStatus(200);
});

// 🛑 STOP
app.post("/stop", (req, res) => {

    if (job) job.stop();

    watchConfig = null;
    status = "Bevakning stoppad";

    console.log("Watch stopped");

    res.sendStatus(200);
});

// 📊 STATUS
app.get("/status", (req, res) => {
    res.json({ status });
});

// 🌐 ROOT
app.get("/", (req, res) => {
    res.send("Servern funkar");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});