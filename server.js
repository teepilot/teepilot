const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { Resend } = require("resend");

const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const app = express();
app.use(cors());
app.use(express.json());

let job = null;
let watchConfig = null;
let status = "Ingen aktiv bevakning";

app.get("/", (req, res) => {
    res.send("<h1>TeePilot API Server</h1><p>Status: " + status + "</p>");
});

async function checkTimes() {
    if (!watchConfig) return;

    try {
        console.log(`[${new Date().toLocaleTimeString()}] Försöker logga in som ${watchConfig.golfId}...`);
        
        // 1. LOGGA IN MED RÄTT HEADERS
        const loginRes = await fetch("https://mingolf.golf.se/sysadmin/api/visit/auth/login", {
            method: "POST",
            headers: {
                "accept": "application/json, text/plain, */*",
                "accept-language": "sv-SE,sv;q=0.9",
                "content-type": "application/json",
                "sec-ch-ua": "\"Chromium\";v=\"123\"",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "referrer": "https://mingolf.golf.se/Login",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({
                username: watchConfig.golfId,
                password: watchConfig.password
            })
        });

        if (!loginRes.ok) {
            const errorData = await loginRes.text();
            console.error("Login-svar från Min Golf:", errorData);
            throw new Error(`Nekad av Min Golf (Status: ${loginRes.status})`);
        }
        
        // Hämta sessionen
        const setCookie = loginRes.headers.get("set-cookie");
        if (!setCookie) throw new Error("Inloggning lyckades men fick ingen session-nyckel");

        console.log("Inloggning lyckades! Hämtar tider...");

        // 2. HÄMTA TIDERNA
        const response = await fetch("https://mingolf.golf.se/sysadmin/api/visit/bokning", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "cookie": setCookie,
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({
                clubId: "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a",
                courseId: "0abbcc77-25a8-4167-83c7-bbf43d6e863c",
                date: watchConfig.date,
                identifyAllPlayers: true
            })
        });

        const data = await response.json();
        
        if (!data.slots || !Array.isArray(data.slots)) {
            console.log("Inga tider hittades i svaret.");
            return;
        }

        const availableSlots = data.slots.filter(slot => {
            const slotTime = slot.time.split("T")[1].substring(0, 5);
            return slotTime >= watchConfig.from && 
                   slotTime <= watchConfig.to && 
                   slot.availablity && 
                   slot.availablity.bookable;
        });

        if (availableSlots.length > 0) {
            const foundTime = availableSlots[0].time.split("T")[1].substring(0, 5);
            console.log("HITTADE TID:", foundTime);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TEE TIME HITTAD!",
                html: `<h1>Tid hittad: ${foundTime}</h1><p>Boka nu på Min Golf!</p>`
            });
            stopJob();
            status = `Klar! Hittade ${foundTime}`;
        } else {
            status = "Bevakning aktiv: Inga lediga tider än...";
            console.log("Sökt, men inga lediga tider i intervallet.");
        }

    } catch (err) {
        console.error("API-fel:", err.message);
        status = "Fel: " + err.message;
        // Vi stoppar inte jobbet här, vi låter det försöka igen nästa minut
    }
}

function stopJob() {
    if (job) job.stop();
    watchConfig = null;
    status = "Ingen aktiv bevakning";
}

app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Startar...";
    if (job) job.stop();
    checkTimes();
    job = cron.schedule("*/1 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    stopJob();
    res.sendStatus(200);
});

app.get("/status", (req, res) => { res.json({ status }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API Server online på port ${PORT}`));