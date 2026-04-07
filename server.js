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

// 🔥 klicka element via text (robust)
async function clickByText(page, match) {
    const elements = await page.$$("div, button, span");

    for (const el of elements) {
        const text = await page.evaluate(e => e.innerText, el);
        if (!text) continue;

        if (text.toLowerCase().includes(match.toLowerCase())) {
            await el.click();
            return true;
        }
    }
    return false;
}

async function sendEmail(email, time) {
    try {
        await resend.emails.send({
            from: "TeePilot <onboarding@resend.dev>",
            to: email,
            subject: "TeeTime hittad ⛳",
            html: `<h2>TeeTime hittad!</h2><p>${time}</p>`
        });
    } catch (err) {
        console.log("Mail error:", err);
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
              "--disable-setuid-sandbox"
            ],
            executablePath: await chromium.executablePath(),
            headless: true
          });

        const page = await browser.newPage();

        await page.setDefaultTimeout(60000);

        // 🔥 GÅ DIREKT TILL BOOKING (fixar login-problemet)
        console.log("Opening booking page...");
        await page.goto("https://mingolf.golf.se/bokning/#/", {
            waitUntil: "domcontentloaded"
        });

        await sleep(5000);

        // 🔥 LOGIN (robust)
        console.log("Checking login...");
        const inputs = await page.$$("input");

        if (inputs.length >= 2) {
            console.log("Typing login...");

            await inputs[0].type(watchConfig.golfId, { delay: 50 });
            await inputs[1].type(watchConfig.password, { delay: 50 });

            await inputs[1].press("Enter");

            await page.waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: 60000
            }).catch(() => {});

            console.log("Logged in...");
        }

        await sleep(8000);

        // COOKIE
        console.log("Handling cookies...");
        await clickByText(page, "acceptera");
        await sleep(2000);

        // 🔥 ÖPPNA KLUBB + BANA (RÄTT ELEMENT)
        console.log("Opening club/bana...");
        const opened = await clickByText(page, "klubb och bana");

        if (!opened) throw new Error("Kunde inte öppna klubb/bana");

        await sleep(3000);

        // 🔥 VÄLJ TOURNAMENT COURSE
        console.log("Selecting Tournament Course...");
        const selected = await clickByText(page, "tournament");

        if (!selected) throw new Error("Hittade inte Tournament Course");

        await sleep(4000);

        // 🔥 DATUM
        console.log("Opening date picker...");
        const dateOpened = await clickByText(page, "när vill du spela");

        if (dateOpened) {
            await sleep(2000);

            const day = watchConfig.date.split("-")[2];
            console.log("Selecting day:", day);

            await clickByText(page, day);
        }

        await sleep(4000);

        // 🔥 HÄMTA TIDER
        console.log("Getting times...");
        const times = await page.evaluate(() =>
            Array.from(document.querySelectorAll("button, div"))
                .map(el => el.innerText)
                .filter(t => /^\d{2}:\d{2}$/.test(t))
        );

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

app.get("/", (req, res) => {
    res.send("Servern funkar");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});