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
            protocolTimeout: 120000
        });

        const page = await browser.newPage();

        // 🔥 SPEED + MEMORY
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

        // 🔐 LOGIN
        console.log("Going to login...");
        await page.goto("https://mingolf.golf.se/login/", {
            waitUntil: "domcontentloaded"
        });

        console.log("Waiting for login...");
        await page.waitForSelector("input[type='password']", { visible: true });

        const inputs = await page.$$("input:not([type='checkbox'])");

        console.log("Typing login...");
        await inputs[0].type(watchConfig.golfId, { delay: 30 });
        await inputs[1].type(watchConfig.password, { delay: 30 });

        console.log("Submitting login...");
        await inputs[1].press("Enter");

        await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
        console.log("Logged in...");

        // 🔥 GÅ TILL BOKNING (RÄTT ROUTE)
        console.log("Going to booking page...");
        await page.goto("https://mingolf.golf.se/bokning/#/", {
            waitUntil: "domcontentloaded"
        });

        await sleep(4000);

        console.log("Searching club...");

        const searchInputs = await page.$$("input");
        
        let searchInput = null;
        
        for (const input of searchInputs) {
            const placeholder = await page.evaluate(el => el.placeholder, input);
        
            if (placeholder && placeholder.toLowerCase().includes("klubb")) {
                searchInput = input;
                break;
            }
        }
        
        // fallback
        if (!searchInput) {
            searchInput = searchInputs[0];
        }
        
        await searchInput.click({ clickCount: 3 });
        await searchInput.type("Vasatorp", { delay: 30 });
        
        await page.waitForSelector("li", { timeout: 10000 });
        
        const clubs = await page.$$("li");
        
        for (const club of clubs) {
            const text = await page.evaluate(el => el.innerText, club);
        
            if (text.toLowerCase().includes("vasatorp")) {
                await club.click();
                break;
            }
        }
        
        await sleep(3000);

        // 🔥 RÄTT DROPDOWN (VIKTIGASTE FIXEN)
        console.log("Opening club/course selector...");

        const selectors = await page.$$("button, div");

        for (const el of selectors) {
            const text = await page.evaluate(e => e.innerText, el);

            if (text.includes("Vasatorps Golfklubb")) {
                await el.click();
                break;
            }
        }

        await sleep(3000);

        console.log("Selecting course...");

        const options = await page.$$("button, li, div");

        for (const opt of options) {
            const text = await page.evaluate(e => e.innerText, opt);

            if (text.includes("Park")) {
                await opt.click();
                break;
            }
        }

        await sleep(4000);

        // 📅 DATUM
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

        // 🕒 HÄMTA TIDER
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

    job = cron.schedule("*/5 * * * *", checkTimes);

    res.sendStatus(200);
});

// 🛑 STOP
app.post("/stop", (req, res) => {

    if (job) job.stop();

    watchConfig = null;
    status = "Stoppad";

    console.log("Watch stopped");

    res.sendStatus(200);
});

// 📊 STATUS
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