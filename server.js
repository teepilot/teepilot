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

        // Skapa session med fasta headers för att undvika 401
        const session = axios.create({
            baseURL: "https://mingolf.golf.se",
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Origin': 'https://mingolf.golf.se',
                'Referer': 'https://mingolf.golf.se/bokning/'
            },
            withCredentials: true // Viktigt för cookies
        });

        // 1. Logga in
        await session.post("/login/api/Users/Login", {
            GolfId: golfId,
            Password: password
        });

        console.log("Inloggning lyckades");

        // 2. Vänta 2 sekunder (viktigt för att sessionen ska "sätta sig")
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 3. Hämta schemat för Vasatorp TC
        const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
        const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await session.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: {
                courseId: TOURNAMENT_COURSE_ID,
                date: date
            }
        });

        const times = scheduleRes.data;
        console.log(`Hämtade ${times.length} tider.`);

        // 4. Filtrera tider
        const availableTimes = times.filter(t => {
            const hour = parseInt(t.time.split(":")[0]);
            return t.isBookable && hour >= from && hour <= to;
        });

        if (availableTimes.length > 0) {
            const timeList = availableTimes.map(t => t.time).join(", ");
            console.log("MATCH HITTAD:", timeList);

            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: "Tid hittad på Vasatorp!",
                html: `<p>Lediga tider den ${date}: <b>${timeList}</b></p>`
            });

            status = `Match funnen! Mail skickat för: ${timeList}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()} (Inga lediga tider)`;
            console.log(status);
        }

    } catch (err) {
        // Om vi får 401 här så loggar vi mer info
        if (err.response && err.response.status === 401) {
            console.error("Fel vid sökning: Obehörig (401). Sessionen godkändes inte.");
            status = "Inloggad, men MinGolf nekade sökningen. Försöker igen...";
        } else {
            console.error("Fel vid sökning:", err.message);
            status = "Ett oväntat fel uppstod.";
        }
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