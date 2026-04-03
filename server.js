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

    console.log("Checking tee times...");

    const browser = await puppeteer.launch({
        args: [
            ...chromium.args,
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage"
        ],
        executablePath: await chromium.executablePath(),
        headless: true
    });

    const page = await browser.newPage();

    await page.setExtraHTTPHeaders({
        "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    

    page.setDefaultNavigationTimeout(60000);

    try {

        console.log("Going to login page...");
        await page.goto("https://mingolf.golf.se/", {
            waitUntil: "networkidle2",
            timeout: 60000
        });

        console.log("Typing login...");
        await page.waitForSelector("#username");
        await page.type("#username", watchConfig.golfId);
        await page.type("#password", watchConfig.password);

        console.log("Click login...");
        await Promise.all([
            page.click("button[type='submit']"),
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
        ]);

        console.log("Logged in");

        console.log("Going to booking...");
        await page.goto("https://mingolf.golf.se/", {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });
        

        await page.waitForTimeout(3000);

        console.log("Searching club...");
        await page.type("input", "Vasatorp");
        await page.waitForTimeout(2000);

        await page.evaluate(() => {
            const club = [...document.querySelectorAll("div")]
                .find(el => el.innerText.includes("Vasatorp"));
            if (club) club.click();
        });

        await page.waitForTimeout(2000);

        console.log("Selecting course...");
        await page.evaluate(() => {
            const course = [...document.querySelectorAll("div")]
                .find(el => el.innerText.includes("Park Course - 12 hål"));
            if (course) course.click();
        });

        await page.waitForTimeout(3000);

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