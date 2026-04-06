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
                "--single-process"
            ],
            executablePath: await chromium.executablePath(),
            headless: "new",
            protocolTimeout: 180000
        });

        const page = await browser.newPage();

        await page.setCacheEnabled(false);
        await page.setDefaultTimeout(30000);
        await page.setDefaultNavigationTimeout(30000);

        await page.setRequestInterception(true);
        page.on("request", (req) => {
            const type = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // LOGIN
        console.log("Going to login...");
        await page.goto("https://mingolf.golf.se/login/", {
            waitUntil: "domcontentloaded"
        });

        await page.waitForSelector("input[type='password']", { visible: true });

        const loginInputs = await page.$$("input:not([type='checkbox'])");

        console.log("Typing login...");
        await loginInputs[0].type(watchConfig.golfId, { delay: 30 });
        await loginInputs[1].type(watchConfig.password, { delay: 30 });

        console.log("Submitting login...");
        await loginInputs[1].press("Enter");

        await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
        console.log("Logged in...");

        // BOOKING PAGE
        console.log("Going to booking page...");
        await page.goto("https://mingolf.golf.se/bokning/#/", {
            waitUntil: "domcontentloaded"
        });

        await sleep(6000);

        // FIND DROPDOWN
        console.log("Finding course dropdown...");

        const elements = await page.$$("button, div");

        let dropdown = null;

        for (const el of elements) {
            const text = await page.evaluate(e => e.innerText, el);

            if (
                text &&
                (
                    text.toLowerCase().includes("bana") ||
                    text.toLowerCase().includes("course") ||
                    text.toLowerCase().includes("tournament") ||
                    text.toLowerCase().includes("park")
                )
            ) {
                console.log("Dropdown candidate:", text);
                dropdown = el;
                break;
            }
        }

        if (!dropdown) {
            throw new Error("Hittade ingen dropdown för bana");
        }

        await dropdown.evaluate(el => el.click());

        await sleep(2000);

        // SELECT COURSE (TOURNAMENT)
        console.log("Selecting course...");

        await page.waitForSelector("[role='option']", { timeout: 10000 });

        const options = await page.$$("[role='option']");

        let foundCourse = false;

        for (const opt of options) {
            const text = await page.evaluate(el => el.innerText, opt);

            console.log("Option:", text);

            if (text.toLowerCase().includes("tournament")) {
                await opt.click();
                foundCourse = true;
                break;
            }
        }

        if (!foundCourse) {
            throw new Error("Kunde inte hitta Tournament Course");
        }

        await sleep(4000);

        // DATE
        console.log("Selecting date...");
        const day = watchConfig.date.split("-")[2];

        const buttons = await page.$$("button");

        for (const btn of buttons) {
            const text = await page.evaluate(el => el.innerText, btn);

            if (text === day) {
                await btn.click();
                break;
            }
        }

        await sleep(4000);

        // TIMES
        console.log("Getting times...");

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button, div"))
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

            status = `Tid hittad: ${time}`;

            if (job) job.stop();
            watchConfig = null;
        }

    } catch (err) {
        console.log("Error:", err);
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch {}
        }

        isRunning = false;
    }
}

// START
app.post("/start", (req, res) => {

    watchConfig = req.body;
    status = "Bevakning aktiv";

    console.log("Watch started:", watchConfig);

    if (job) job.stop();

    checkTimes();

    job = cron.schedule("*/5 * * * *", checkTimes);

    res.sendStatus(200);
});

// STOP
app.post("/stop", (req, res) => {

    if (job) job.stop();

    watchConfig = null;
    status = "Stoppad";

    console.log("Watch stopped");

    res.sendStatus(200);
});

// STATUS
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