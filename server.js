const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const { Resend } = require("resend");

const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const app = express();
app.use(cors());
app.use(express.json());

// Skapa en Cookie Jar som sparar inloggningen automatiskt
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

app.get("/", (req, res) => res.send(`<h1>TeePilot Status</h1><p>${status}</p>`));
app.get("/status", (req, res) => res.json({ status }));

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`\n--- [${new Date().toLocaleTimeString()}] SKANNING STARTAR ---`);
        const { golfId, password, date, from, to, email } = watchConfig;

        await jar.removeAllCookies();

        // 1. Logga in
        await client.post("/login/api/Users/Login", {
            GolfId: golfId, Password: password
        }, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
        });

        // 2. Hämta SCHEMA
        const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
        const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: TOURNAMENT_COURSE_ID, date: date }
        });

        let allSlots = Array.isArray(scheduleRes.data) ? scheduleRes.data : (scheduleRes.data?.slots || []);
        const availableSlots = [];

        // 3. Loopa igenom tiderna med den nya strukturen
        allSlots.forEach(slot => {
            if (!slot.time || !slot.availablity) return;

            // Extrahera timmen ur "2026-05-06T09:00:00Z" -> blir 9
            const timePart = slot.time.split("T")[1]; // "09:00:00Z"
            const slotHour = parseInt(timePart.split(":")[0], 10);
            
            const targetFrom = parseInt(from, 10);
            const targetTo = parseInt(to, 10);

            if (slotHour >= targetFrom && slotHour <= targetTo) {
                // Här använder vi den korrekta sökvägen till datan:
                const isBookable = slot.availablity.bookable; // Är tiden öppen?
                const availableSpaces = slot.availablity.availableSlots; // Antal lediga platser
                const isLocked = slot.isLocked; // Är tiden spärrad av klubben?

                // Snyggare tid för loggen (09:00 istället för hela strängen)
                const displayTime = timePart.substring(0, 5);

                console.log(`Koll: ${displayTime} | Lediga: ${availableSpaces} | Bokningsbar: ${isBookable} | Låst: ${isLocked}`);

                // Vi hittar en tid om den är bokningsbar, inte låst och har minst 1 plats ledig
                if (isBookable && !isLocked && availableSpaces > 0) {
                    availableSlots.push(displayTime);
                }
            }
        });

        if (availableSlots.length > 0) {
            const timeList = availableSlots.join(", ");
            console.log(`MATCH HITTAD: ${timeList}`);

            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: "Tid hittad på Vasatorp!",
                html: `<h3>Lediga tider hittade!</h3><p>Det finns nu lediga platser den ${date} kl: <b>${timeList}</b></p>`
            });

            status = `Match funnen! Mail skickat för: ${timeList}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()}: Inga lediga platser mellan ${from}-${to}`;
            console.log(status);
        }

    } catch (err) {
        console.error("Fel:", err.message);
        status = "Kunde inte skanna just nu.";
    } finally {
        isSearching = false;
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
    status = "Bevakning startad för Vasatorp TC";
    checkTimes(); 
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server körs på port ${PORT}`));