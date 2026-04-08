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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Kraftfullare klick-funktion som letar efter text i listor/dropdowns
async function clickDropdownItem(page, match) {
    try {
        await page.waitForFunction(
            (text) => {
                const items = Array.from(document.querySelectorAll(".v-list-item, .v-list-item__title, span, div"));
                return items.some(i => i.innerText.toLowerCase().includes(text.toLowerCase()));
            },
            { timeout: 5000 },
            match
        );

        return await page.evaluate((text) => {
            const items = Array.from(document.querySelectorAll(".v-list-item, .v-list-item__title, span, div"));
            const target = items.find(i => i.innerText.trim().toLowerCase().includes(text.toLowerCase()));
            if (target) {
                target.click();
                return true;
            }
            return false;
        }, match);
    } catch (e) { return false; }
}

async function checkTimes() {
    if (isRunning || !watchConfig) return;
    isRunning = true;

    let browser;
    try {
        browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
            executablePath: await chromium.executablePath(),
            headless: true
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });

        await sleep(5000);

        // --- 1. LOGIN ---
        const inputs = await page.$$("input");
        if (inputs.length >= 2) {
            await inputs[0].type(watchConfig.golfId);
            await inputs[1].type(watchConfig.password);
            await inputs[1].press("Enter");
            await sleep(7000);
        }

        // --- 2. HANTERA COOKIES ---
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const ok = btns.find(b => b.innerText.toLowerCase().includes('acceptera') || b.innerText.toLowerCase().includes('ok'));
            if (ok) ok.click();
        });
        await sleep(2000);

        // --- 3. VÄLJ BANA VIA DROPDOWN ---
        console.log("Öppnar ban-dropdown...");
        // Klickar på rutan för Klubb och Bana
        await page.click('.v-select__slot'); 
        await sleep(2000);
        
        // Här väljer vi "Tournament Course" direkt i dropdownen
        const courseSelected = await clickDropdownItem(page, "Tournament Course");
        if (!courseSelected) {
            console.log("Kunde inte hitta banan i listan, försöker söka...");
            const search = await page.$('input[placeholder*="Sök"]');
            if (search) {
                await search.type("Vasatorps Golfklubb");
                await sleep(2000);
                await clickDropdownItem(page, "Tournament Course");
            }
        }

        // --- 4. VÄLJ DATUM VIA KALENDER ---
        console.log("Öppnar kalender...");
        // Klickar på "När vill du spela"
        await page.evaluate(() => {
            const dateSection = Array.from(document.querySelectorAll('div')).find(d => d.innerText.includes('När vill du spela'));
            if (dateSection) dateSection.click();
        });
        await sleep(2000);

        const dayToSelect = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`Klickar på datum: ${dayToSelect}`);
        
        // Letar efter rätt dag i kalendern (.v-btn__content brukar siffrorna ligga i)
        await page.evaluate((day) => {
            const days = Array.from(document.querySelectorAll('.v-btn__content, .v-date-picker-table button'));
            const targetDay = days.find(d => d.innerText.trim() === day);
            if (targetDay) targetDay.click();
        }, dayToSelect);
        
        await sleep(4000); // Vänta på att tiderna laddas om

        // --- 5. LÄS AV TIDER ---
        const slots = await page.evaluate(() => {
            // Hittar alla element som ser ut som tids-knappar
            return Array.from(document.querySelectorAll('button, .v-card'))
                .map(el => el.innerText)
                .filter(txt => /\d{2}:\d{2}/.test(txt) && !txt.includes("Fullbokad") && !txt.includes("Ej bokningsbar"));
        });

        console.log("Hittade lediga tider:", slots);

        const match = slots.find(s => {
            const time = s.match(/\d{2}:\d{2}/)[0];
            return time >= watchConfig.from && time <= watchConfig.to;
        });

        if (match) {
            const finalTime = match.match(/\d{2}:\d{2}/)[0];
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: watchConfig.email,
                subject: "TeeTime hittad! ⛳",
                html: `<h3>Tid hittad på Vasatorp!</h3><p>Det finns en ledig tid kl <b>${finalTime}</b>.</p>`
            });
            status = `Tid hittad: ${finalTime}`;
            if (job) job.stop();
            watchConfig = null;
        } else {
            status = `Kollat ${new Date().toLocaleTimeString()}: Inga tider lediga.`;
        }

    } catch (err) {
        console.log("Fel i körning:", err.message);
        status = "Ett fel uppstod vid senaste sökningen.";
    } finally {
        if (browser) await browser.close();
        isRunning = false;
    }
}

// Standard API-endpunkter
app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad";
    if (job) job.stop();
    checkTimes(); // Kör direkt
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    if (job) job.stop();
    watchConfig = null;
    status = "Stoppad";
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));
app.get("/", (req, res) => res.send("TeePilot Server Ready"));

app.listen(process.env.PORT || 3000);