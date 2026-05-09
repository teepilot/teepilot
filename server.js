const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const webpush = require("web-push");

const app = express();
app.use(cors());
app.use(express.json());

const publicVapidKey = 'BLLZHq_76mIHTDyWAXaC4wP4KBbuLuWmQNhOi76JdPToRm1J3OxXQP8Xym5ceQ6Z_-1QuF-UpmacTDhFsKBa0_I'; 
const privateVapidKey = '02XTay5ukVQyDFgXR3VHAV2ouWZktANNJVI1jVJaB3A';

webpush.setVapidDetails(
    'mailto:info@teepilot.se',
    publicVapidKey,
    privateVapidKey
);

async function sendPushNotification(subscription, courseName, time) {
    const payload = JSON.stringify({
        title: 'TeePilot: Match funnen! ⛳',
        body: `${courseName} kl ${time} är nu ledig. Snabba dig!`
    });

    try {
        await webpush.sendNotification(subscription, payload);
        console.log("Push-notis skickad!");
    } catch (err) {
        console.error("Fel vid sändning av push-notis:", err);
    }
}

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

const VASATORP_CLUB_ID = "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a";

app.get("/", (req, res) => res.send(`<h1>TeePilot Server Status</h1><p>${status}</p>`));
app.get("/status", (req, res) => res.json({ status }));

async function checkTimes() {
    if (!watchConfig || isSearching) return;
    isSearching = true;

    try {
        console.log(`\n--- [${new Date().toLocaleTimeString('sv-SE')}] SKANNING STARTAR ---`);
        
        const { golfId, password, date, from, to, courseId, pushSubscription } = watchConfig;

        const loginRes = await client.post("/api/session/login", {
            username: golfId,
            password: password
        });

        const targetCourse = courseId || "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const searchRes = await client.get(`/api/itinerary/search/tee-times/v2/items`, {
            params: {
                clubId: VASATORP_CLUB_ID,
                courseId: targetCourse,
                date: date,
                players: 4,
                holeCount: 18
            }
        });

        const slots = searchRes.data.items || [];
        const availableSlots = slots.filter(s => {
            const hour = parseInt(s.time.split(":")[0]);
            return s.isAvailable && s.availableSlots >= 4 && hour >= from && hour <= to;
        });

        if (availableSlots.length > 0) {
            let courseName = "Vald bana";
            if (targetCourse === "0abbcc77-25a8-4167-83c7-bbf43d6e863c") courseName = "Tournament Course";
            else if (targetCourse === "aaa98917-7e69-4f2b-8eaf-0ed7956ebf00") courseName = "Park Course";

            status = {
                found: true,
                course: courseName,
                times: availableSlots, 
                date: date
            };
            
            console.log(`MATCH FUNNEN på ${courseName}`);

            if (pushSubscription) {
                const firstTime = availableSlots[0].time;
                const subObj = typeof pushSubscription === 'string' ? JSON.parse(pushSubscription) : pushSubscription;
                sendPushNotification(subObj, courseName, firstTime);
            }

            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString('sv-SE')}: Inga lediga 4-bollar hittade än.`;
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
    status = `Bevakar ${watchConfig.date}...`;
    
    checkTimes();
    job = cron.schedule("*/30 * * * * *", checkTimes);
    
    res.json({ message: "Bevakning startad", config: watchConfig });
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    status = "Bevakning stoppad manuellt.";
    res.json({ message: "Bevakning stoppad" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server körs på port ${PORT}`));