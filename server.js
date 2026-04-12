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
        });

        const page = await activeBrowser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        page.setDefaultNavigationTimeout(60000);

        // 1. LOGIN (Din stabila metod)
        console.log("[LOG] Navigerar till Login...");
        await page.goto("https://mingolf.golf.se/Login", { waitUntil: "domcontentloaded" });
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
            page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {})
        ]);

        // 2. BOKNINGSSIDA
        console.log("[LOG] Går till bokningssida...");
        await page.goto("https://mingolf.golf.se/bokning/#/", { waitUntil: "networkidle2" });
        await new Promise(r => setTimeout(r, 7000)); 

        // 3. DATUMVAL (Förbättrad)
        const dayToPick = watchConfig.date.split("-")[2].replace(/^0+/, ''); 
        console.log(`[LOG] Letar efter datum: ${dayToPick}...`);
        await page.evaluate((day) => {
            const btns = Array.from(document.querySelectorAll("button, .v-btn__content"));
            const target = btns.find(el => el.innerText && el.innerText.trim() === day);
            if (target) {
                target.scrollIntoView();
                target.click();
            }
        }, dayToPick);
        
        // VIKTIGT: Vänta på att datum-laddningen blir klar innan banval
        await new Promise(r => setTimeout(r, 4000));

        // 4. BANVAL (Förbättrad med klick-verifiering)
        console.log("[LOG] Väljer Tournament Course...");
        await page.evaluate(() => {
            const allElements = Array.from(document.querySelectorAll("div, span, button, p, h3"));
            const courseBtn = allElements.find(e => e.innerText && e.innerText.includes("Tournament Course"));
            if (courseBtn) {
                courseBtn.click();
                // Scrolla ner för att aktivera laddning av tider
                window.scrollBy(0, 500);
            }
        });
        
        console.log("[LOG] Väntar på att tiderna ska renderas...");
        await new Promise(r => setTimeout(r, 6000)); 

        // 5. LÄS TIDER (Med extra koll på "visa fler" om det finns)
        const times = await page.evaluate(() => {
            // Ibland ligger tiderna i knappar, ibland i divar med specifik klass
            const buttons = Array.from(document.querySelectorAll("button"));
            return buttons
                .map(el => el.innerText.trim())
                .filter(text => text.match(/^\d{2}:\d{2}$/));
        });

        if (times.length > 0) {
            console.log(`[INFO] Tider funna: ${times.length} stycken.`);
            const available = times.find(t => t >= watchConfig.from && t <= watchConfig.to);

            if (available) {
                console.log(`[MATCH] Hittade tid: ${available}`);
                await resend.emails.send({
                    from: "TeePilot <onboarding@resend.dev>",
                    to: [watchConfig.email],
                    subject: "TeeTime hittad ⛳!",
                    html: `<h2>Tid hittad: ${available}</h2><p>Datum: ${watchConfig.date}</p>`
                });
                status = `Träff! ${available}`;
                stopEverything();
            } else {
                status = `Sökt ${new Date().toLocaleTimeString()} (Ingen ledig i intervallet)`;
                console.log(`[INFO] Tider utanför intervall: ${times.join(", ")}`);
            }
        } else {
            console.log("[WARN] Fortfarande inga tider. Sidan kan kräva ett klick till eller mer tid.");
            status = "Hittade inga tider. Kontrollera datum/bana på skärmen.";
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
    console.log("Stoppar all bevakning och stänger webbläsare...");
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
    console.log("Startar bevakning för:", watchConfig.golfId);
    checkTimes();
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

app.get("/status", (req, res) => res.json({ status }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server körs!`));