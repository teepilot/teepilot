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

async function clickCourseDropdown(page) {

    console.log("Trying to find dropdown via position...");

    for (let attempt = 0; attempt < 5; attempt++) {

        const buttons = await page.$$("div, button");

        for (const el of buttons) {
            const text = await page.evaluate(e => e.innerText, el);

            if (!text) continue;

            const t = text.toLowerCase();

            // 🔥 SKIP COOKIE & SKRÄP
            if (t.length > 80) continue;
            if (t.includes("reklam") || t.includes("cookies")) continue;

            // 🔥 DETTA ÄR KEY
            if (
                t.includes("hål") ||
                t.includes("course") ||
                t.includes("tournament") ||
                t.includes("park")
            ) {
                console.log("Found dropdown:", text);
                await el.click();
                return true;
            }
        }

        console.log("Retry dropdown...");
        await sleep(2000);
    }

    return false;
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

        // LOGIN
        console.log("Going to login...");
        await page.goto("https://mingolf.golf.se/login/", {
            waitUntil: "domcontentloaded"
        });

        await page.waitForSelector("input[type='password']");

        const inputs = await page.$$("input:not([type='checkbox'])");

        console.log("Typing login...");
        await inputs[0].type(watchConfig.golfId);
        await inputs[1].type(watchConfig.password);

        console.log("Submitting login...");
        await inputs[1].press("Enter");

        await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
        console.log("Logged in...");

        // BOOKING
        console.log("Going to booking page...");
        await page.goto("https://mingolf.golf.se/bokning/#/", {
            waitUntil: "networkidle2"
        });

        await sleep(8000);

        // COOKIE
        console.log("Handling cookie popup...");
        try {
            const btns = await page.$$("button");
            for (const b of btns) {
                const t = await page.evaluate(el => el.innerText, b);
                if (t && t.toLowerCase().includes("acceptera")) {
                    console.log("Accepted cookies");
                    await b.click();
                    await sleep(2000);
                    break;
                }
            }
        } catch {}

        // 🔥 DROPDOWN (FINAL FIX)
        console.log("Opening dropdown...");

        const opened = await clickCourseDropdown(page);

        if (!opened) {
            throw new Error("Kunde inte hitta dropdown (final fail)");
        }

        await sleep(3000);

        // SELECT COURSE
        console.log("Selecting Tournament Course...");

        const options = await page.$$("[role='option'], li");

        let found = false;

        for (const opt of options) {
            const text = await page.evaluate(el => el.innerText, opt);

            if (!text) continue;

            console.log("Option:", text);

            if (text.toLowerCase().includes("tournament")) {
                await opt.click();
                found = true;
                break;
            }
        }

        if (!found) {
            throw new Error("Tournament Course hittades inte");
        }

        await sleep(4000);

        // DATE
        console.log("Selecting date...");
        const day = watchConfig.date.split("-")[2];

        const btns = await page.$$("button");

        for (const b of btns) {
            const t = await page.evaluate(el => el.innerText, b);
            if (t === day) {
                await b.click();
                break;
            }
        }

        await sleep(4000);

        // TIMES
        console.log("Getting times...");

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button, div"))
                .map(el => el.innerText)
                .filter(t => /^\d{2}:\d{2}$/.test(t));
        });

        console.log("Times found:", times);

        const available = times.filter(t =>
            t >= watchConfig.from && t <= watchConfig.to
        );

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
            try { await browser.close(); } catch {}
        }
        isRunning = false;
    }
}

// ROUTES
app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning aktiv";

    console.log("Watch started:", watchConfig);

    if (job) job.stop();

    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);

    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    if (job) job.stop();
    watchConfig = null;
    status = "Stoppad";
    res.sendStatus(200);
});

app.get("/status", (req, res) => {
    res.json({ status });
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Server running");
});