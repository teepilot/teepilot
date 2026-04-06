const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const cron = require("node-cron");

const { Resend } = require("resend");
const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");

const app = express();
app.use(cors());
app.use(express.json());

let job = null;
let watchConfig = null;
let isRunning = false;

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function sendEmail(email, time) {
    try {
        await resend.emails.send({
            from: "TeePilot <onboarding@resend.dev>",
            to: email,
            subject: "TeeTime hittad ⛳",
            html: `<h2>Tid hittad: ${time}</h2>`
        });

        console.log("Mail sent");
    } catch (err) {
        console.log("Mail error:", err);
    }
}

// 🔁 MAIN CHECK
async function checkTimes() {

    if (!watchConfig) {
        console.log("No config, skipping...");
        return;
    }

    if (isRunning) {
        console.log("Skipping - already running");
        return;
    }

    isRunning = true;

    let browser;

    try {

        console.log("Launching browser...");

        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: true
        });

        const page = await browser.newPage();

        // 🔐 LOGIN
        console.log("Going to login...");

        await page.goto("https://mingolf.golf.se/login/", {
            waitUntil: "domcontentloaded"
        });

        await page.waitForSelector("input[type='password']", { timeout: 10000 });

        const inputs = await page.$$("input:not([type='checkbox'])");

        console.log("Typing login...");
        await inputs[0].type(watchConfig.golfId);
        await inputs[1].type(watchConfig.password);

        console.log("Submitting login...");
        await inputs[1].press("Enter");

        await sleep(3000);

        console.log("Logged in...");

        // 🚀 GÅ DIREKT TILL BOKNING
        await page.goto("https://mingolf.golf.se/bokning/#/", {
            waitUntil: "domcontentloaded"
        });

        await sleep(4000);

        console.log("Searching club...");

        // 🔥 KLICKA "Vasatorp"
        const buttons = await page.$$("button");

        for (let btn of buttons) {
            const text = await page.evaluate(el => el.innerText, btn);

            if (text && text.toLowerCase().includes("vasatorp")) {
                await btn.click();
                break;
            }
        }

        await sleep(2000);

        console.log("Selecting course...");

        // 🔥 VÄLJ "Park Course"
        const options = await page.$$("li");

        for (let opt of options) {
            const text = await page.evaluate(el => el.innerText, opt);

            if (text && text.toLowerCase().includes("park")) {
                await opt.click();
                break;
            }
        }

        await sleep(3000);

        console.log("Getting times...");

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(b => b.innerText)
                .filter(t => /^\d{2}:\d{2}$/.test(t));
        });

        console.log("Times:", times);

        const available = times.filter(t =>
            t >= watchConfig.from && t <= watchConfig.to
        );

        if (available.length > 0) {

            const time = available[0];

            console.log("FOUND:", time);

            await sendEmail(watchConfig.email, time);

            if (job) job.stop();
            watchConfig = null;
        }

    } catch (err) {
        console.log("Error:", err);
    }

    if (browser) await browser.close();

    isRunning = false;
}

// 🚀 START
app.post("/start", (req, res) => {

    watchConfig = req.body;

    console.log("Watch started:", watchConfig);

    if (job) job.stop();

    checkTimes();

    job = cron.schedule("*/2 * * * *", checkTimes);

    res.sendStatus(200);
});

// 🛑 STOP
app.post("/stop", (req, res) => {

    if (job) job.stop();

    watchConfig = null;

    res.sendStatus(200);
});

app.get("/", (req, res) => {
    res.send("Running 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});