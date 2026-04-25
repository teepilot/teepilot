const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { Resend } = require("resend");

const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const app = express();
app.use(cors());
app.use(express.json());

let job = null;
let watchConfig = null;
let status = "Ingen aktiv bevakning";
let isSearching = false;

// Inställningar för Vasatorp Tournament Course från din research
const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

app.get("/", (req, res) => res.send(`<h1>TeePilot Status</h1><p>${status}</p>`));
app.get("/status", (req, res) => res.json({ status }));

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`--- [${new Date().toLocaleTimeString()}] API-sökning startar ---`);
        const { golfId, password, date, from, to, email } = watchConfig;

        // 1. Skapa en session för att hantera cookies automatiskt
        const session = axios.create({
            baseURL: "https://mingolf.golf.se",
            headers: {
                "Content-Type": "application/json",
                "Origin": "https://mingolf.golf.se",
                "Referer": "https://mingolf.golf.se/login/"
            }
        });

        // 2. Logga in för att få mgat-cookien
        const loginResponse = await session.post("/login/api/Users/Login", {
            GolfId: golfId,
            Password: password
        });

        console.log("Inloggning lyckades");

        // 3. Hämta schemat för banan
        const scheduleResponse = await session.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: {
                courseId: TOURNAMENT_COURSE_ID,
                date: date
            }
        });

        const allSlots = scheduleResponse.data; // MinGolf returnerar en array med tider
        
        // 4. Filtrera fram lediga tider i ditt intervall
        const availableSlots = allSlots.filter(slot => {
            const timeHour = parseInt(slot.time.split(":")[0]);
            // slot.isBookable verkar vara flaggan för om den går att boka
            return slot.isBookable && timeHour >= from && timeHour <= to;
        });

        if (availableSlots.length > 0) {
            const timeList = availableSlots.map(s => s.time).join(", ");
            console.log(`MATCH HITTAD: ${timeList}`);

            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: "TeeTime Hittad på Vasatorp!",
                html: `<h1>Tider hittade!</h1><p>Följande tider är lediga på Tournament Course den ${date}: <strong>${timeList}</strong></p>`
            });

            status = `Match funnen! Mail skickat för tider: ${timeList}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()}: Inga lediga tider mellan ${from}-${to}`;
            console.log(status);
        }

    } catch (err) {
        console.error("Fel vid sökning:", err.response?.data || err.message);
        status = "Fel vid kontakt med MinGolf. Kontrollera inloggningsuppgifter.";
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
    checkTimes(); // Kör direkt en gång
    job = cron.schedule("*/5 * * * *", checkTimes); // Sedan var 5:e minut
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server körs på port ${PORT}`));