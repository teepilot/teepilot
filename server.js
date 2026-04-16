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
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process"
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        page.setDefaultTimeout(40000);
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // Blockering för att spara RAM men behåll CSS för klickbarhet
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'media', 'font'].includes(type)) req.abort();
            else req.continue();
        });

        // 1. LOGIN
        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("input[type='password']", { timeout: 30000 });

        await page.evaluate((id, pw) => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const u = inputs.find(i => i.type === "text" || i.type === "email");
            const p = inputs.find(i => i.type === "password");
            if (u && p) { u.value = id; p.value = pw; }
        }, watchConfig.golfId, watchConfig.password);

        console.log("[LOG] Skickar inloggning...");
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 8000)); 

        // 2. GÅ TILL BOKNING
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });
        
        // 3. VÄLJ BANA OCH DATUM (DEEP SEARCH LOOP)
        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Söker efter Tournament Course och datum ${day}...`);

        const interaction = await page.evaluate(async (d) => {
            const delay = (ms) => new Promise(r => setTimeout(r, ms));
            
            // A. Försök stänga eventuella banners (Cookies/Info)
            const allElements = Array.from(document.querySelectorAll("button, span, div"));
            const closeBtn = allElements.find(el => 
                ["Godkänn", "OK", "Stäng", "Accept"].some(txt => el.innerText?.includes(txt))
            );
            if (closeBtn) {
                closeBtn.click();
                await delay(1500);
            }

            // B. Vänta på Tournament Course i en loop (max 15 sekunder)
            let courseBtn = null;
            for (let i = 0; i < 30; i++) {
                const els = Array.from(document.querySelectorAll("button, .v-btn__content, span, div, p"));
                courseBtn = els.find(el => el.innerText?.includes("Tournament Course"));
                if (courseBtn) break;
                await delay(500);
            }

            if (!courseBtn) return { cOk: false, dOk: false, msg: "Hittade inte banan" };

            // C. Klicka på banan
            courseBtn.click();
            await delay(4000); // Vänta på att kalendern laddas efter banval

            // D. Klicka på datumet (Exakt matchning av siffran)
            const elsAfter = Array.from(document.querySelectorAll("button, .v-btn__content, span"));
            const dateBtn = elsAfter.find(el => el.innerText?.trim() === d);
            
            if (dateBtn) {
                dateBtn.click();
                return { cOk: true, dOk: true };
            }

            return { cOk: true, dOk: false, msg: "Hittade banan men inte datumet" };
        }, day);

        console.log(`[LOG] Resultat: ${interaction.cOk ? "Bana OK" : "Bana MISS"} | ${interaction.dOk ? "Datum OK" : "Datum MISS"}`);
        if (interaction.msg) console.log(`[DEBUG] ${interaction.msg}`);

        if (interaction.cOk && interaction.dOk) {
            console.log("[LOG] Väntar på tider...");
            await new Promise(r => setTimeout(r, 7000)); 

            // 4. LÄS AV TIDER
            const times = await page.evaluate(() => {
                return Array.from(document.querySelectorAll("button, .v-btn"))
                    .map(el => el.innerText ? el.innerText.trim() : "")
                    .filter(text => /^\d{2}:\d{2}$/.test(text));
            });

            if (times.length > 0) {
                console.log(`[INFO] Hittade tider: ${times.join(", ")}`);
                const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

                if (available) {
                    console.log("[MATCH] Skickar mail!");
                    await resend.emails.send({
                        from: "TeePilot <onboarding@resend.dev>",
                        to: [watchConfig.email],
                        subject: "TeeTime hittad ⛳!",
                        html: `<h2>Tid hittad: ${available}</h2><p>Bana: Tournament Course</p><p>Datum: ${watchConfig.date}</p>`
                    });
                    status = `Träff! ${available}`;
                    stopEverything();
                } else {
                    status = `Sökt ${new Date().toLocaleTimeString()} (Ingen match i intervallet)`;
                }
            } else {
                console.log("[WARN] Inga tider synliga på sidan.");
                status = "Inga tider hittade";
            }
        } else {
            status = interaction.msg || "Kunde inte klicka på valen";
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Försöker igen nästa cykel...";
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`TeePilot redo på port ${PORT}`));