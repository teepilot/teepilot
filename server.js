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
                "--disable-gpu"
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            protocolTimeout: 240000 // 4 minuter för att hantera Renders seghet
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // Blockera allt utom scripts och dokument för att spara kraft
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        // 1. LOGIN
        console.log("[LOG] Navigerar till Login...");
        // Vi väntar inte på någon laddningstyp alls, vi bara kör
        await page.goto("https://mingolf.golf.se/Login").catch(() => {});

        console.log("[LOG] Väntar på inmatningsfält...");
        // Vi väntar upp till 60 sekunder på fältet
        const passwordInput = await page.waitForSelector("input[type='password']", { timeout: 60000 });

        if (passwordInput) {
            await page.evaluate((id, pw) => {
                const inputs = Array.from(document.querySelectorAll("input"));
                const u = inputs.find(i => i.type === "text" || i.type === "email");
                const p = inputs.find(i => i.type === "password");
                if (u) u.value = id;
                if (p) p.value = pw;
            }, watchConfig.golfId, watchConfig.password);

            console.log("[LOG] Skickar inloggning...");
            await page.keyboard.press('Enter');
            // Vänta på att inloggningen ska processas utan att kräva navigation-event
            await new Promise(r => setTimeout(r, 8000)); 
        }

        // 2. BOKNINGSSIDA
        console.log("[LOG] Går till bokningssida...");
        // Här använder vi catch för att ignorera timeout-felet och fortsätta ändå
        await page.goto("https://mingolf.golf.se/bokning/#/", { timeout: 60000 }).catch(() => {
            console.log("[LOG] Navigation timeout ignorerad, kollar om sidan laddats ändå...");
        });
        
        await new Promise(r => setTimeout(r, 10000)); 

        // 3. DATUM & BANA
        const dayToPick = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Söker datum ${dayToPick} och Tournament Course...`);

        const result = await page.evaluate(async (day) => {
            const findAndClick = (text, exact = false) => {
                const els = Array.from(document.querySelectorAll("button, span, div, p"));
                const found = els.find(el => {
                    const t = el.innerText ? el.innerText.trim() : "";
                    return exact ? t === text : t.includes(text);
                });
                if (found) { found.click(); return true; }
                return false;
            };

            const dOk = findAndClick(day, true);
            await new Promise(r => setTimeout(r, 2000));
            const cOk = findAndClick("Tournament Course", false);
            return { dOk, cOk };
        }, dayToPick);

        console.log(`[LOG] Status - Datum: ${result.dOk}, Bana: ${result.cOk}`);
        await new Promise(r => setTimeout(r, 5000)); 

        // 4. LÄS TIDER
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        if (times.length > 0) {
            console.log(`[INFO] Tider funna: ${times.join(", ")}`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

            if (available) {
                console.log("[MATCH] Skickar mail!");
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "TeeTime hittad ⛳!",
                    html: `<h2>Tid hittad: ${available}</h2>`
                });
                status = `Träff! ${available}`;
                stopEverything();
            }
        } else {
            status = `Senaste koll: ${new Date().toLocaleTimeString()} (0 tider funna)`;
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Försöker igen nästa cykel...";
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