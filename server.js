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
        console.log(`--- [${new Date().toLocaleTimeString()}] DIAGNOS-SKANNING ---`);
        const { golfId, password, date, from, to, email } = watchConfig;

        await jar.removeAllCookies();

        // 1. Logga in
        await client.post("/login/api/Users/Login", {
            GolfId: golfId, Password: password
        }, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
        });

        console.log("Inloggning lyckades");
        await new Promise(r => setTimeout(r, 2000));

        // 2. Hämta SCHEMA
        const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";
        const TOURNAMENT_COURSE_ID = "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: TOURNAMENT_COURSE_ID, date: date }
        });

        let allSlots = [];
        if (Array.isArray(scheduleRes.data)) allSlots = scheduleRes.data;
        else if (scheduleRes.data?.slots) allSlots = scheduleRes.data.slots;

        console.log(`Totalt antal tider från API: ${allSlots.length}`);
        
        const availableSlots = [];
        const targetFrom = parseInt(from, 10);
        const targetTo = parseInt(to, 10);

        console.log(`Letar mellan kl: ${targetFrom} och ${targetTo}`);

        // 3. Gå igenom VARJE tid
        allSlots.forEach(slot => {
            if (!slot.time) return;

            // Extrahera timmen (hanterar både "09:10" och "9:10")
            const slotHour = parseInt(slot.time.split(":")[0], 10);
            
            // LOGGA ABSOLUT ALLT inom intervallet för diagnos
            if (slotHour >= targetFrom && slotHour <= targetTo) {
                const booked = slot.playersBooked || 0;
                const max = slot.maxPlayers || 4;
                const spaceLeft = max - booked;
                
                // Denna rad skriver ut exakt vad MinGolf ser i din logg
                console.log(
                    `KOLL -> Tid: ${slot.time} | ` +
                    `Status: ${slot.status} | ` +
                    `Platser: ${booked}/${max} | ` +
                    `Bokningsbar: ${slot.isBookable}`
                );

                // LOGIK: När ska vi anse att tiden är "hittad"?
                // Vi kollar om det finns platser kvar OCH om statusen inte är "Occupied" eller "Blocked"
                const isAvailable = (spaceLeft > 0) && 
                                    (slot.status === "Available" || slot.status === 0 || slot.status === null) &&
                                    (slot.status !== "Occupied");

                if (isAvailable) {
                    availableSlots.push(slot);
                }
            }
        });

        console.log(`-------------------------------------------------`);

        if (availableSlots.length > 0) {
            const timeList = availableSlots.map(s => s.time).join(", ");
            console.log(`MATCH FUNNEN: ${timeList}`);

            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: email,
                subject: "TeePilot: Tid hittad!",
                html: `<h2>Tider lediga!</h2><p>Följande tider på Vasatorp TC är lediga: <b>${timeList}</b></p>`
            });

            status = `Match funnen! Mail skickat för: ${timeList}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString()}: Inga lediga platser hittade.`;
            console.log(status);
        }

    } catch (err) {
        console.error("FEL VID SÖKNING:", err.message);
        status = "Kunde inte hämta tider. Försöker igen om 5 min.";
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