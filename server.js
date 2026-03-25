const { Resend } = require("resend");
const resend = new Resend("re_LsNw1rqb_JkfuAXhJauGjNLcMaS3ihRthno");

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
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
            from: "onboarding@resend.dev",
            to: email,
            subject: "TeeTime hittad ⛳",
            html: `
                <div style="font-family:Arial;padding:20px">
                    <h2>TeeTime hittad!</h2>
                    <p>En tid finns kl <b>${time}</b></p>
                    <p>Gå in på MinGolf för att boka.</p>
                </div>
            `
        });

        console.log("Mail sent to", email);

    } catch (err) {
        console.log("Email error:", err);
    }
}

async function checkTimes() {

    console.log("🔥 checkTimes körs");
    if (!watchConfig) return;

    console.log("Checking tee times...");

    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox"]
    });

    const page = await browser.newPage();

    try {

        await page.goto("https://mingolf.golf.se/");
        await page.waitForSelector("#username");

        await page.type("#username", watchConfig.golfId);
        await page.type("#password", watchConfig.password);

        await page.click("button[type='submit']");
        await page.waitForNavigation();

        console.log("Logged in");

        await page.goto("https://mingolf.golf.se/bokning/#/");
        await page.waitForTimeout(3000);

        await page.type("input", "Vasatorp");
        await page.waitForTimeout(2000);

        await page.evaluate(() => {
            const club = [...document.querySelectorAll("div")]
                .find(el => el.innerText.includes("Vasatorp"));
            if (club) club.click();
        });

        await page.waitForTimeout(2000);

        await page.evaluate(() => {
            const course = [...document.querySelectorAll("div")]
                .find(el => el.innerText.includes("Park Course - 12 hål"));
            if (course) course.click();
        });

        await page.waitForTimeout(3000);

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

    checkTimes(); // kör direkt
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


app.listen(3000, () => {
    console.log("Server running on port 3000");
});