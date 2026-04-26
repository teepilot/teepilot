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
        console.log(`\n=================================================`);
        console.log(`--- [${new Date().toLocaleTimeString()}] TOTAL DIAGNOS ---`);
        const { golfId, password, date, from, to, email } = watchConfig;

        await jar.removeAllCookies();

        // 1. Logga in
        await client.post("/login/api/Users/Login", {
            GolfId: golfId, Password: password
        }, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
        });

        console.log("Inloggning lyckades");

        // 2. Hämta SCHEMA
        const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
        const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: TOURNAMENT_COURSE_ID, date: date }
        });

        // --- VIKTIGT: SE HUR DATAN SER UT ---
        console.log("Rådata-typ:", typeof scheduleRes.data);
        
        // Vi försöker hitta listan med tider oavsett vad den heter
        let allSlots = [];
        if (Array.isArray(scheduleRes.data)) {
            allSlots = scheduleRes.data;
        } else {
            // Om det är ett objekt, leta efter vanliga list-namn
            allSlots = scheduleRes.data.slots || scheduleRes.data.items || scheduleRes.data.bookings || [];
        }

        console.log(`Antal objekt i listan: ${allSlots.length}`);

        if (allSlots.length > 0) {
            // Vi loggar precis allt i det första objektet för att se fältnamnen
            console.log("Fältnamn i första tidsobjektet:", Object.keys(allSlots[0]));
            console.log("Exempel på innehåll (första tiden):", JSON.stringify(allSlots[0]));
        }

        const availableSlots = [];
        const targetFrom = parseInt(from, 10);
        const targetTo = parseInt(to, 10);

        // 3. Den "smarta" loopen
        for (const slot of allSlots) {
            // MinGolf kan använda 'time', 'startTime' eller 'start'
            const timeStr = slot.time || slot.startTime || slot.start;
            if (!timeStr) continue;

            const slotHour = parseInt(timeStr.split(/[:T ]/)[1] || timeStr.split(":")[0], 10);
            
            if (slotHour >= targetFrom && slotHour <= targetTo) {
                const booked = slot.playersBooked ?? slot.bookedCount ?? 0;
                const max = slot.maxPlayers ?? 4;
                const isBookable = slot.isBookable || slot.status === "Available" || slot.status === 0;

                console.log(`Tid: ${timeStr} | Status: ${slot.status} | Bokade: ${booked}/${max}`);

                if (booked < max && slot.status !== "Blocked") {
                    availableSlots.push({ ...slot, time: timeStr });
                }
            }
        }

        if (availableSlots.length > 0) {
            const timeList = availableSlots.map(s => s.time).join(", ");
            console.log(`MATCH! Mailar: ${timeList}`);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: "TeePilot: Tid hittad!",
                html: `Tider: ${timeList}`
            });
            status = `Match funnen: ${timeList}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()}: Inga lediga hittade i intervallet.`;
        }

    } catch (err) {
        console.error("KRITISKT FEL:", err.message);
        status = "Systemfel vid skanning.";
    } finally {
        isSearching = false;
        console.log(`=================================================\n`);
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