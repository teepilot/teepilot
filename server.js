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
        console.log(`--- [${new Date().toLocaleTimeString()}] Startar sökning ---`);
        status = "Sökning pågår...";

        activeBrowser = await puppeteer.launch({
            args: [...chromium.args, "--disable-blink-features=AutomationControlled", "--single-process"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            defaultViewport: { width: 1280, height: 1000 }
        });

        const page = await activeBrowser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        page.setDefaultNavigationTimeout(60000);

        // --- DIN GAMLA FUNGERANDE INLOGGNING (ORÖRD) ---
        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });

        console.log("[LOG] Väntar på inmatningsfält...");
        await page.waitForSelector("input[type='password']", { timeout: 40000 });

        const inputs = await page.$$("input");
        for (const input of inputs) {
            const type = await page.evaluate(el => el.type, input);
            if (type === "text" || type === "email") await input.type(watchConfig.golfId);
            if (type === "password") await input.type(watchConfig.password);
        }

        console.log("[LOG] Skickar inloggning...");
        await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => console.log("Navigering tog tid, men fortsätter..."))
        ]);

        // --- HÄRIFRÅN KÖR VI DEN NYA TEST-LOGIKEN FÖR BOKNINGSSIDAN ---
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 8000)); 

        // 1. KLICKA DATUM
        const dayToPick = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Letar efter datum: ${dayToPick}...`);
        
        await page.evaluate((day) => {
            const btns = Array.from(document.querySelectorAll("button, .v-btn__content, span"));
            const target = btns.find(el => el.innerText && el.innerText.trim() === day);
            if (target) target.click();
        }, dayToPick);

        await new Promise(r => setTimeout(r, 4000));

        // 2. VÄLJ BANA (Med mus-simulering)
        console.log("[LOG] Väljer Tournament Course...");
        const courseHandle = await page.evaluateHandle(() => {
            const elements = Array.from(document.querySelectorAll("div, span, button, p"));
            return elements.find(e => e.innerText && e.innerText.includes("Tournament Course"));
        });

        if (courseHandle.asElement()) {
            const courseEl = courseHandle.asElement();
            await courseEl.hover();
            await new Promise(r => setTimeout(r, 1000));
            await courseEl.click();
            console.log("[LOG] Ban-klick utfört.");
        }

        // 3. VÄNTA PÅ INNEHÅLL (Tidsknappar)
        console.log("[LOG] Väntar på att tiderna ska renderas...");
        try {
            await page.waitForFunction(() => {
                const buttons = Array.from(document.querySelectorAll("button"));
                return buttons.some(btn => btn.innerText.trim().match(/^\d{2}:\d{2}$/));
            }, { timeout: 15000 });
            console.log("[LOG] Tider hittade!");
        } catch (e) {
            console.log("[WARN] Inga tider dök upp.");
        }

        // 4. LÄS TIDER
        const times = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        console.log("[INFO] Tider funna:", times.join(", "));
        
        const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

        if (available) {
            console.log("[MATCH] Skickar mail...");
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TeeTime hittad ⛳!",
                html: `<h2>Tid hittad: ${available}</h2><p>Datum: ${watchConfig.date}</p>`
            });
            status = `Hittad: ${available}`;
            stopEverything();
        } else {
            status = `Sökt kl ${new Date().toLocaleTimeString()} (Inga lediga)`;
        }

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        status = "Fel vid sökning...";
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
    console.log("Stoppar all bevakning...");
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server online!`));