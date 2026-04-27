const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

const app = express();
app.use(cors());
app.use(express.json());

// --- KONFIGURATION ---
const TELEGRAM_TOKEN = "DIN_BOT_TOKEN_HÄR"; // Fås från @BotFather
const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";

const jar = new CookieJar();
const client = wrapper(axios.create({ 
    jar, 
    withCredentials: true,
    baseURL: "https://mingolf.golf.se" 
}));

let job = null;
let watchConfig = null;
let status = "Ingen aktiv bevakning";
let isSearching = false;

// Status-endpoints
app.get("/", (req, res) => res.send(`<h1>TeePilot Server Status</h1><p>${status}</p>`));
app.get("/status", (req, res) => res.json({ status }));

// Funktion för att skicka Telegram-meddelande
async function sendTelegram(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: chatId,
            text: text,
            parse_mode: "HTML"
        });
        console.log("Telegram-notis skickad!");
    } catch (err) {
        console.error("Telegram Error:", err.response?.data || err.message);
    }
}

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`\n--- [${new Date().toLocaleTimeString('sv-SE')}] SKANNING STARTAR ---`);
        const { golfId, password, date, from, to, telegramChatId, courseId } = watchConfig;

        await jar.removeAllCookies();

        // 1. Logga in
        await client.post("/login/api/Users/Login", {
            GolfId: golfId,
            Password: password
        }, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mingolf.golf.se/login/'
            }
        });

        // 2. Hämta schema
        const targetCourse = courseId || "0abbcc77-25a8-4167-83c7-bbf43d6e863c";
        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: targetCourse, date: date }
        });

        let allSlots = Array.isArray(scheduleRes.data) ? scheduleRes.data : (scheduleRes.data?.slots || []);
        const foundTimes = [];

        // 3. Analysera tider
        allSlots.forEach(slot => {
            if (!slot.time || !slot.availablity) return;

            const timePart = slot.time.split("T")[1]; 
            const hourSwe = parseInt(timePart.split(":")[0], 10) + 2; // Justering för svensk tid
            
            if (hourSwe >= parseInt(from) && hourSwe <= parseInt(to)) {
                if (slot.availablity.bookable && !slot.isLocked && slot.availablity.availableSlots === 4) {
                    foundTimes.push(timePart.substring(0, 5));
                }
            }
        });

        if (foundTimes.length > 0) {
            const timeList = foundTimes.join(", ");
            const courseName = targetCourse === "aaa98917-7e69-4f2b-8eaf-0ed7956ebf00" ? "Classic Course" : "Tournament Course";
            
            const message = `🚀 <b>TeePilot: Ledig tid hittad!</b>\n\n` +
                            `📍 <b>Bana:</b> ${courseName}\n` +
                            `📅 <b>Datum:</b> ${date}\n` +
                            `⏰ <b>Tider:</b> ${timeList}\n\n` +
                            `<i>Skynda dig in på MinGolf och boka!</i>`;

            await sendTelegram(telegramChatId, message);

            status = `Match funnen! Notis skickad till Telegram för tiderna: ${timeList}`;
            stopEverything();
        } else {
            status = `Söker... Senast kollad: ${new Date().toLocaleTimeString('sv-SE')}. Inga 4-bollar hittade än.`;
            console.log(status);
        }

    } catch (err) {
        console.error("Fel vid sökning:", err.message);
        status = "Kunde inte ansluta till MinGolf. Kontrollera inloggningsuppgifter.";
    } finally {
        isSearching = false;
    }
}

async function stopEverything() {
    if (job) { job.stop(); job = null; }
    watchConfig = null;
    isSearching = false;
}

app.post("/start", async (req, res) => {
    await stopEverything();
    watchConfig = req.body;
    status = `Bevakar ${watchConfig.date} via Telegram...`;
    
    checkTimes(); // Kör direkt
    job = cron.schedule("*/5 * * * *", checkTimes); // Sedan var 5:e minut
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    status = "Ingen aktiv bevakning";
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TeePilot Server körs på port ${PORT}`));