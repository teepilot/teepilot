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
        console.log(`--- [${new Date().toLocaleTimeString()}] DIAGNOS-SÖKNING STARTAR ---`);
        const { golfId, password, date, from, to, email } = watchConfig;

        await jar.removeAllCookies();

        await client.post("/login/api/Users/Login", {
            GolfId: golfId, Password: password
        }, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
        });

        const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
        const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: TOURNAMENT_COURSE_ID, date: date }
        });

        let allSlots = [];
        if (Array.isArray(scheduleRes.data)) allSlots = scheduleRes.data;
        else if (scheduleRes.data?.slots) allSlots = scheduleRes.data.slots;

        console.log(`Totalt antal tider mottagna: ${allSlots.length}`);

        // --- DIAGNOS: LOGGA DE FÖRSTA 3 TIDERNA FÖR ATT SE STRUKTUREN ---
        if (allSlots.length > 0) {
            console.log("EXEMPEL PÅ DATA FRÅN MINGOLF:");
            console.log(JSON.stringify(allSlots.slice(0, 3), null, 2)); 
        }

        const availableSlots = allSlots.filter(slot => {
            const timeHour = parseInt(slot.time?.split(":")[0]);
            if (isNaN(timeHour)) return false;

            // Vi kollar tidspannet
            const isInTimeRange = timeHour >= from && timeHour <= to;
            
            // Kolla om bollen inte är full (här kollar vi på 'isFull' eller 'playersBooked')
            // Vi tillåter allt som inte är markerat som "Stängt" eller "Fullt"
            const looksAvailable = slot.isBookable === true || 
                                   slot.status === "Available" || 
                                   (slot.maxPlayers > (slot.playersBooked || 0) && slot.status !== "Blocked");

            if (isInTimeRange) {
                console.log(`Analys -> Tid: ${slot.time} | Status: ${slot.status} | Bookable: ${slot.isBookable} | Platser: ${slot.playersBooked}/${slot.maxPlayers}`);
            }

            return isInTimeRange && looksAvailable;
        });

        if (availableSlots.length > 0) {
            const timeList = availableSlots.map(s => s.time).join(", ");
            console.log("MATCH HITTAD!");
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: "Tid hittad!",
                html: `Lediga tider: ${timeList}`
            });
            status = `Match funnen: ${timeList}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()}: Inga lediga tider mellan ${from}-${to}`;
            console.log(status);
        }

    } catch (err) {
        console.error("DIAGNOS-FEL:", err.message);
        status = "Fel vid sökning. Se logg.";
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