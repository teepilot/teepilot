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
let mgatCookie = null;
let isRunning = false;

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 📧 MAIL
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

// 🔐 LOGIN → HÄMTA COOKIE
async function loginAndGetCookie() {

    if (!watchConfig) throw new Error("No config in login");

    console.log("Logging in to get cookie...");

    const browser = await puppeteer.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true
    });

    const page = await browser.newPage();

    await page.goto("https://mingolf.golf.se/login/", {
        waitUntil: "domcontentloaded"
    });

    await page.waitForSelector("input[type='password']");

    const inputs = await page.$$("input:not([type='checkbox'])");

    await inputs[0].type(watchConfig.golfId);
    await inputs[1].type(watchConfig.password);
    await inputs[1].press("Enter");

    // 🔥 Vänta på cookie istället för navigation
    let mgat = null;

    for (let i = 0; i < 20; i++) {
        const cookies = await page.cookies();
        mgat = cookies.find(c => c.name === "mgat");

        if (mgat) break;

        await sleep(1000);
    }

    await browser.close();

    if (!mgat) throw new Error("No mgat cookie after login");

    mgatCookie = `mgat=${mgat.value}`;
    console.log("Got cookie ✅");
}

// 📡 FETCH TIMES VIA API
async function fetchTimes() {

    console.log("Fetching times via API...");

    const res = await fetch("https://mingolf.golf.se/sysadmin/api/visit/bokning", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Cookie": mgatCookie
        },
        body: JSON.stringify({
            date: watchConfig.date,
            course: "Park",
            club: "Vasatorp"
        })
    });

    const data = await res.json();

    console.log("API response:", JSON.stringify(data).slice(0, 500));

    let times = [];

    if (data?.times) {
        times = data.times.map(t => t.time);
    }

    return times;
}

// 🔁 CHECK LOOP
async function checkTimes() {

    // ✅ FIX: stoppa om ingen config
    if (!watchConfig) {
        console.log("No config, skipping...");
        return;
    }

    if (isRunning) {
        console.log("Skipping - already running");
        return;
    }

    isRunning = true;

    try {

        if (!mgatCookie) {
            await loginAndGetCookie();
        }

        const times = await fetchTimes();

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

        // 🔄 cookie expired → logga in igen nästa gång
        mgatCookie = null;
    }

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
    mgatCookie = null;

    res.sendStatus(200);
});

app.get("/", (req, res) => {
    res.send("API version running 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});