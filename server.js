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

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function sendEmail(email, time) {
    await resend.emails.send({
        from: "TeePilot <onboarding@resend.dev>",
        to: email,
        subject: "TeeTime hittad ⛳!",
        html: `<h2>TeeTime hittad!</h2><p>${time}</p>`
    });
}

async function safeGoto(page, url) {
    for (let i = 0; i < 3; i++) {
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            return;
        } catch {
            console.log("Retrying navigation...");
            await sleep(2000);
        }
    }
    throw new Error("Kunde inte ladda sida");
}

async function acceptCookies(page) {
    const buttons = await page.$$("button");
    for (const b of buttons) {
        const t = await page.evaluate(el => el.innerText, b);
        if (t && t.toLowerCase().includes("acceptera")) {
            console.log("Accepted cookies");
            await b.click();
            await sleep(2000);
            return;
        }
    }
}

async function openDropdown(page) {
    console.log("Opening dropdown...");

    for (let attempt = 0; attempt < 5; attempt++) {

        const els = await page.$$("div, button");

        for (const el of els) {
            const text = await page.evaluate(e => e.innerText, el);

            if (!text) continue;

            const t = text.toLowerCase();

            if (t.length > 80) continue;
            if (t.includes("reklam") || t.includes("cookies")) continue;

            if (
                t.includes("hål") ||
                t.includes("course") ||
                t.includes("tournament") ||
                t.includes("park")
            ) {
                console.log("Dropdown found:", text);
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

    let browser;

    try {

        browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox"],
            executablePath: await chromium.executablePath(),
            headless: "new"
        });

        const page = await browser.newPage();

        // LOGIN
        console.log("Going to login...");
        await safeGoto(page, "https://mingolf.golf.se/login/");

        await page.waitForSelector("input[type='password']");

        const inputs = await page.$$("input:not([type='checkbox'])");

        await inputs[0].type(watchConfig.golfId);
        await inputs[1].type(watchConfig.password);

        await inputs[1].press("Enter");

        await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});

        console.log("Logged in");

        // BOOKING
        console.log("Going to booking page...");
        await safeGoto(page, "https://mingolf.golf.se/bokning/#/");

        await sleep(8000);

        await acceptCookies(page);

        // DROPDOWN
        const ok = await openDropdown(page);

        if (!ok) throw new Error("Dropdown hittades inte");

        await sleep(3000);

        // SELECT COURSE
        const options = await page.$$("[role='option'], li");

        let found = false;

        for (const o of options) {
            const text = await page.evaluate(el => el.innerText, o);

            if (!text) continue;

            console.log("Option:", text);

            if (text.toLowerCase().includes("tournament")) {
                await o.click();
                found = true;
                break;
            }
        }

        if (!found) throw new Error("Course ej hittad");

        await sleep(4000);

        // DATE
        const day = watchConfig.date.split("-")[2];

        const buttons = await page.$$("button");

        for (const b of buttons) {
            const t = await page.evaluate(el => el.innerText, b);
            if (t === day) {
                await b.click();
                break;
            }
        }

        await sleep(4000);

        // TIMES
        const times = await page.evaluate(() =>
            Array.from(document.querySelectorAll("button, div"))
                .map(el => el.innerText)
                .filter(t => /^\d{2}:\d{2}$/.test(t))
        );

        const available = times.filter(t =>
            t >= watchConfig.from && t <= watchConfig.to
        );

        if (available.length > 0) {
            const time = available[0];
            console.log("FOUND:", time);
            await sendEmail(watchConfig.email, time);
        }

    } catch (err) {
        console.log("Error:", err);
    } finally {
        if (browser) await browser.close();
        isRunning = false;
    }
}

// ROUTES
app.post("/start", (req, res) => {
    watchConfig = req.body;

    if (job) job.stop();

    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);

    res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Server running");
});