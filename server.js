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
        page.setDefaultTimeout(30000);
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // BLOCKERING: Vi stoppar bilder och typsnitt, men BEHÅLLER CSS (för att knapparna ska synas)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'media', 'font'].includes(type)) req.abort();
            else req.continue();
        });

        // 1. LOGIN
        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
        await page.waitForSelector("input[type='password']", { timeout: 20000 });

        await page.evaluate((id, pw) => {
            const inputs = Array.from(document.querySelectorAll("input"));
            const u = inputs.find(i => i.type === "text" || i.type === "email");
            const p = inputs.find(i => i.type === "password");
            if (u && p) { u.value = id; p.value = pw; }
        }, watchConfig.golfId, watchConfig.password);

        console.log("[LOG] Skickar inloggning...");
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 6000)); 

        // 2. GÅ TILL BOKNING
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });
        // Ge sidan ordentligt med tid att ladda in banlistan
        await new Promise(r => setTimeout(r, 10000)); 

        // 3. VÄLJ BANA OCH DATUM
        const day = watchConfig.date.split("-")[2].replace(/^0+/, ''); 

        console.log("[LOG] Letar efter knappar på sidan...");
        const results = await page.evaluate(async (d) => {
            // Scrolla lite för att väcka sidan
            window.scrollBy(0, 300);
            await new Promise(r => setTimeout(r, 500));
            window.scrollBy(0, -300);

            const findAndClick = (text, exact = false) => {
                // Vi letar i alla vanliga klickbara element
                const elements = Array.from(document.querySelectorAll("button, .v-btn__content, span, div, p"));
                const target = elements.find(el => {
                    const content = el.innerText ? el.innerText.trim() : "";
                    return exact ? content === text : content.includes(text);
                });
                
                if (target) {
                    target.click();
                    return true;
                }
                return false;
            };

            // Klicka bana först
            const cOk = findAndClick("Tournament Course", false);
            
            // Vänta på att kalendern reagerar
            if (cOk) await new Promise(r => setTimeout(r, 2000));
            
            // Klicka datum
            const dOk = findAndClick(d, true);
            
            return { cOk, dOk };
        }, day);

        console.log(`[LOG] Bana: ${results.cOk}, Datum: ${results.dOk}`);

        if (results.cOk || results.dOk) {
            // Vänta på att tiderna laddas in i listan
            await new Promise(r => setTimeout(r, 6000)); 

            // 4. LÄS AV TIDER
            const times = await page.evaluate(() => {
                // Tider på Min Golf ligger oftast i knappar med formatet "HH:mm"
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
                    status = `Sökt ${new Date().toLocaleTimeString()} (Ingen match)`;
                }
            } else {
                console.log("[WARN] Inga tidsknappar synliga ännu.");
                status = "Inga tider hittade";
            }
        } else {
            console.log("[ERROR] Kunde inte interagera med bana/datum.");
            status = "Kunde inte klicka på valen";
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

app.listen(process.env.PORT || 10000, () => console.log("Server online!"));