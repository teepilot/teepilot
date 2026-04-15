const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const { Resend } = require("resend");

const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const app = express();
app.use(cors());
app.use(express.json());

let job = null;
let watchConfig = null;
let status = "Ingen aktiv bevakning";
let isSearching = false;

app.get("/", (req, res) => res.send(`<h1>TeePilot Status</h1><p>${status}</p>`));

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    let browser = null;
    try {
        console.log(`--- [${new Date().toLocaleTimeString()}] Startar sökning ---`);
        
        browser = await puppeteer.launch({
            args: [
                ...chromium.args, 
                "--disable-blink-features=AutomationControlled", 
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            protocolTimeout: 180000 
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // Optimering: Skippa tunga bilder men behåll scripts och nödvändig layout
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // 1. SNABB LOGIN
        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("input[type='password']", { timeout: 30000 });

        await page.evaluate((id, pw) => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const u = inputs.find(i => i.type === "text" || i.type === "email");
            const p = inputs.find(i => i.type === "password");
            if (u) u.value = id;
            if (p) p.value = pw;
        }, watchConfig.golfId, watchConfig.password);

        console.log("[LOG] Skickar inloggning...");
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 4000)); 

        // 2. BOKNINGSSIDA
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });
        
        // 3. ROBUST VAL AV DATUM OCH BANA
        const dayToPick = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Söker datum ${dayToPick} och Tournament Course...`);

        // Vi använder en loop inuti evaluate för att vänta på att rätt element dyker upp
        const result = await page.evaluate(async (day) => {
            const findAndClick = (text, exact = false) => {
                const els = Array.from(document.querySelectorAll("button, span, div, p, a"));
                const found = els.find(el => {
                    const elText = el.innerText ? el.innerText.trim() : "";
                    return exact ? elText === text : elText.includes(text);
                });
                if (found) {
                    found.click();
                    return true;
                }
                return false;
            };

            // Försök hitta datum först
            let dateOk = false;
            for (let i = 0; i < 10; i++) { // Försök i 5 sekunder
                if (findAndClick(day, true)) {
                    dateOk = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            // Vänta lite på att banlistan uppdateras efter datumklick
            await new Promise(r => setTimeout(r, 1000));

            // Försök hitta bana
            let courseOk = false;
            for (let i = 0; i < 10; i++) {
                if (findAndClick("Tournament Course", false)) {
                    courseOk = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            return { dateOk, courseOk };
        }, dayToPick);

        console.log(`[LOG] Status - Datum: ${result.dateOk}, Bana: ${result.courseOk}`);
        
        // 4. VÄNTA PÅ TIDERNA
        await new Promise(r => setTimeout(r, 5000)); 

        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        if (times.length > 0) {
            console.log(`[INFO] Tider funna: ${times.join(", ")}`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

            if (available) {
                console.log("[MATCH] BINGO!");
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "TeeTime hittad ⛳!",
                    html: `<h2>Tid hittad: ${available}</h2><p>Datum: ${watchConfig.date}</p>`
                });
                status = `Träff! ${available}`;
                stopEverything();
            } else {
                status = `Sökt kl ${new Date().toLocaleTimeString()} (Inga lediga)`;
            }
        } else {
            console.log("[WARN] Inga tider dök upp på skärmen.");
            status = "Inga tider synliga";
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Fel: " + err.message;
    } finally {
        if (browser) await browser.close();
        isSearching = false;
        console.log("-----------------------------------------------");
    }
}

async function stopEverything() {
    if (job) { job.stop(); job = null; }
    watchConfig = null;
    status = "Ingen aktiv bevakning";
    isSearching = false;
}

app.post("/start", async (req, res) => {
    await stopEverything();
    watchConfig = req.body;
    status = "Bevakning startad";
    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

app.listen(process.env.PORT || 10000, () => console.log("Server online!"));