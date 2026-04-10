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
let activeBrowser = null;

app.get("/", (req, res) => res.send(`<h1>TeePilot Status</h1><p>${status}</p>`));

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`--- [${new Date().toLocaleTimeString()}] Startar söksekvens ---`);
        status = "Sökning pågår...";

        activeBrowser = await puppeteer.launch({
            args: [...chromium.args, "--disable-blink-features=AutomationControlled", "--single-process"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await activeBrowser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        page.setDefaultNavigationTimeout(60000);

        // 1. NAVIGERA TILL LOGIN
        console.log("[STEP 1] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });

        // Hantera cookies om de dyker upp
        try {
            await page.waitForSelector("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", { timeout: 5000 });
            await page.click("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll");
            console.log("[LOG] Cookies accepterade.");
        } catch (e) {
            console.log("[LOG] Ingen cookie-banner.");
        }

        // 2. DEN ROBUSTA INLOGGNINGSMETODEN (Letar efter alla inputs)
        console.log("[STEP 2] Identifierar inloggningsfält...");
        await new Promise(r => setTimeout(r, 3000)); // Vänta lite extra för säkerhets skull
        
        const inputsFilled = await page.evaluate((config) => {
            const allInputs = Array.from(document.querySelectorAll("input"));
            let userFilled = false;
            let passFilled = false;

            allInputs.forEach(input => {
                const type = input.type.toLowerCase();
                const name = (input.name || "").toLowerCase();
                const id = (input.id || "").toLowerCase();

                // Identifiera användarnamn (text, email eller specifika namn)
                if (!userFilled && (type === "text" || type === "email" || name.includes("user") || id.includes("user"))) {
                    input.value = config.golfId;
                    userFilled = true;
                }
                // Identifiera lösenord
                else if (!passFilled && type === "password") {
                    input.value = config.password;
                    passFilled = true;
                }
            });
            return userFilled && passFilled;
        }, watchConfig);

        if (inputsFilled) {
            console.log("[LOG] Fyllt i uppgifter via bred skanning.");
            await Promise.all([
                page.keyboard.press('Enter'),
                page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {})
            ]);
        } else {
            throw new Error("Kunde inte hitta inloggningsfälten.");
        }

        // 3. NAVIGERA TILL BOKNING
        console.log("[STEP 3] Går till bokningssidan...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });
        await new Promise(r => setTimeout(r, 5000)); 

        // 4. VÄLJ TOURNAMENT COURSE (Klickar baserat på text)
        console.log("[STEP 4] Väljer Tournament Course...");
        const clickResult = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll("div, span, p, button, li, a"));
            const target = elements.find(el => el.innerText && el.innerText.trim() === "Tournament Course");
            if (target) {
                target.click();
                return "KLICKAD";
            }
            // Om exakt match misslyckas, prova "includes"
            const fallback = elements.find(el => el.innerText && el.innerText.includes("Tournament Course"));
            if (fallback) {
                fallback.click();
                return "KLICKAD (FALLBACK)";
            }
            return "HITTADES EJ";
        });

        console.log(`[LOG] Banval-status: ${clickResult}`);
        await new Promise(r => setTimeout(r, 4000)); // Vänta på att tiderna ritas ut

        // 5. SKANNA TIDER
        console.log("[STEP 5] Skannar tidsknappar...");
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        if (times.length > 0) {
            console.log(`[INFO] Hittade tider: ${times.join(", ")}`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

            if (available) {
                console.log(`[MATCH] BINGO! Skickar mail för ${available}`);
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "TeeTime hittad ⛳!",
                    html: `<h2>Tid hittad: ${available}</h2><p>Datum: ${watchConfig.date}</p>`
                });
                status = `Träff! Tid: ${available}`;
                await stopEverything();
            } else {
                status = `Sökt ${new Date().toLocaleTimeString()} (Ingen ledig än)`;
            }
        } else {
            console.log("[WARN] Inga tidsknappar hittades på sidan.");
            status = "Kunde inte hitta tider (Väntar på nästa försök)";
        }

    } catch (err) {
        console.error(`[CRITICAL ERROR] ${err.message}`);
        status = "Fel vid sökning: " + err.message;
    } finally {
        if (activeBrowser) {
            await activeBrowser.close();
            activeBrowser = null;
        }
        isSearching = false;
        console.log("-----------------------------------------------");
    }
}

async function stopEverything() {
    if (job) { job.stop(); job = null; }
    watchConfig = null;
    status = "Ingen aktiv bevakning";
    if (activeBrowser) {
        try { await activeBrowser.close(); } catch (e) {}
        activeBrowser = null;
    }
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

app.listen(process.env.PORT || 3000, () => console.log("Server online!"));