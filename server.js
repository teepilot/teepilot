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
        console.log(`--- [${new Date().toLocaleTimeString()}] API-sökning startar ---`);
        const { golfId, password, date, from, to, email } = watchConfig;

        await jar.removeAllCookies();

        // 1. Logga in
        await client.post("/login/api/Users/Login", {
            GolfId: golfId,
            Password: password
        }, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://mingolf.golf.se',
                'Referer': 'https://mingolf.golf.se/login/'
            }
        });

        console.log("Inloggning lyckades");
        await new Promise(r => setTimeout(r, 2000));

        // 2. Hämta SCHEMA
        const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
        const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: TOURNAMENT_COURSE_ID, date: date },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mingolf.golf.se/bokning/'
            }
        });

        // --- KORRIGERING HÄR ---
        // Vi säkerställer att vi har en array att filtrera på
        let allSlots = [];
        if (Array.isArray(scheduleRes.data)) {
            allSlots = scheduleRes.data;
        } else if (scheduleRes.data && Array.isArray(scheduleRes.data.slots)) {
            allSlots = scheduleRes.data.slots;
        } else if (scheduleRes.data && Array.isArray(scheduleRes.data.items)) {
            allSlots = scheduleRes.data.items;
        }

        console.log(`Hämtade ${allSlots.length} tider.`);

        // 3. Filtrera tider (Aggressiv sökning)
        console.log("Analyserar tillgänglighet...");
                
        const availableSlots = allSlots.filter(slot => {
            if (!slot.time) return false;
            
            const timeHour = parseInt(slot.time.split(":")[0]);
            
            // Vi kollar på hur många som är inbokade i bollen. 
            // Om 'maxPlayers' är 4 och 'playersBooked' är mindre än 4, så finns det plats!
            const hasSpace = slot.maxPlayers > (slot.playersBooked || 0);
            
            // Vi kollar också om statusen INTE är "Blocked" eller "Occupied"
            const isNotBlocked = slot.status !== "Blocked" && slot.status !== "Occupied";

            // Logga för att se vad som händer
            if (timeHour >= from && timeHour <= to) {
                console.log(`Tid: ${slot.time} | Lediga platser: ${slot.maxPlayers - slot.playersBooked} | Status: ${slot.status} | Bookable: ${slot.isBookable}`);
            }

            // Vi returnerar sant om det finns plats, statusen är ok och det är rätt timme
            return hasSpace && isNotBlocked && timeHour >= from && timeHour <= to;
        });

        if (availableSlots.length > 0) {
            const timeList = availableSlots.map(s => s.time).join(", ");
            console.log(`MATCH HITTAD: ${timeList}`);

            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: "Tid hittad på Vasatorp!",
                html: `<h1>Tid hittad!</h1><p>Lediga tider på Tournament Course den ${date}: <strong>${timeList}</strong></p>`
            });

            status = `Match funnen! Mail skickat för: ${timeList}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()}: Inga lediga tider mellan ${from}-${to}`;
            console.log(status);
        }

    } catch (err) {
        console.error("Fel vid sökning:", err.message);
        status = "Kunde inte hämta tider just nu. Försöker igen om 5 min.";
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