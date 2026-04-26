const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const { Resend } = require("resend");

// Din Resend API-nyckel
const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const app = express();
app.use(cors());
app.use(express.json());

// Hantering av cookies för att hålla inloggningen vid liv
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

app.get("/", (req, res) => res.send(`<h1>TeePilot Server Status</h1><p>${status}</p>`));
app.get("/status", (req, res) => res.json({ status }));

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`\n--- [${new Date().toLocaleTimeString('sv-SE')}] SKANNING STARTAR ---`);
        const { golfId, password, date, from, to, email } = watchConfig;

        // Töm cookies för att säkerställa en fräsch session
        await jar.removeAllCookies();

        // 1. Logga in på MinGolf
        await client.post("/login/api/Users/Login", {
            GolfId: golfId,
            Password: password
        }, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mingolf.golf.se/login/'
            }
        });

        // 2. Hämta schemat för Vasatorp TC
        const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
        const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: TOURNAMENT_COURSE_ID, date: date }
        });

        // Hantera olika format på API-svaret
        let allSlots = Array.isArray(scheduleRes.data) ? scheduleRes.data : (scheduleRes.data?.slots || []);
        const availableSlots = [];

        // 3. Analysera tiderna
        allSlots.forEach(slot => {
            if (!slot.time || !slot.availablity) return;

            // Tidsformat från API: "2026-05-06T09:00:00Z" (UTC)
            const timePart = slot.time.split("T")[1]; // "09:00:00Z"
            const utcHour = parseInt(timePart.split(":")[0], 10);
            
            // JUSTERING: +2 timmar för Svensk Sommartid (UTC+2)
            const slotHourSwe = utcHour + 2;
            const targetFrom = parseInt(from, 10);
            const targetTo = parseInt(to, 10);

            if (slotHourSwe >= targetFrom && slotHourSwe <= targetTo) {
                const isBookable = slot.availablity.bookable;
                const availableSpaces = slot.availablity.availableSlots;
                const isLocked = slot.isLocked;

                // Skapa en snygg tidsstämpel för logg och mail
                const minutes = timePart.split(":")[1];
                const displayTimeSwe = `${slotHourSwe.toString().padStart(2, '0')}:${minutes}`;

                console.log(`Kontroll: ${displayTimeSwe} | Lediga: ${availableSpaces} | Bokningsbar: ${isBookable}`);

                // Krav: Måste vara bokningsbar, inte låst och ha minst 1 plats ledig
                if (isBookable && !isLocked && availableSpaces > 0) {
                    availableSlots.push(displayTimeSwe);
                }
            }
        });

        if (availableSlots.length > 0) {
            const timeList = availableSlots.join(", ");
            console.log(`MATCH HITTAD: ${timeList}`);

            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: `Tid hittad på Vasatorp! (${date})`,
                html: `
                    <div style="font-family: sans-serif; background: #f4f4f4; padding: 20px;">
                        <h2>TeePilot har hittat lediga tider!</h2>
                        <p>Följande tider är nu tillgängliga på <b>Tournament Course</b> den ${date}:</p>
                        <p style="font-size: 18px; color: #2e7d32;"><b>${timeList}</b></p>
                        <p>Skynda dig in på MinGolf och boka!</p>
                    </div>
                `
            });

            status = `Match funnen! Mail skickat för: ${timeList}`;
            stopEverything(); // Stoppar bevakningen efter träff
        } else {
            status = `Sökt ${new Date().toLocaleTimeString('sv-SE')}: Inga lediga tider mellan ${from}-${to}`;
            console.log(status);
        }

    } catch (err) {
        console.error("Fel vid sökning:", err.message);
        status = "Kunde inte ansluta till MinGolf. Försöker igen om 5 min.";
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
    status = `Bevakar tider för ${watchConfig.date}...`;
    
    // Kör direkt en gång
    checkTimes(); 
    
    // Starta sedan schemaläggning var 5:e minut
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    status = "Ingen aktiv bevakning";
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server körs på port ${PORT}`));