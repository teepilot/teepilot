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
        console.log(`[${new Date().toLocaleTimeString()}] Kollar tider via API...`);
        
        // 1. LOGGA IN OCH HÄMTA TOKEN
        const loginRes = await fetch("https://mingolf.golf.se/sysadmin/api/visit/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                username: watchConfig.golfId,
                password: watchConfig.password
            })
        });

        if (!loginRes.ok) throw new Error("Inloggning misslyckades (Fel ID/Lösenord)");
        
        // Hämta 'mgat' cookien från svaret (detta är din nyckel)
        const setCookie = loginRes.headers.get("set-cookie");
        if (!setCookie) throw new Error("Kunde inte hämta session från Min Golf");

        // 2. HÄMTA TIDERNA
        const response = await fetch("https://mingolf.golf.se/sysadmin/api/visit/bokning", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "cookie": setCookie // Här skickar vi med den färska nyckeln vi nyss fick
            },
            body: JSON.stringify({
                clubId: "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a",
                courseId: "0abbcc77-25a8-4167-83c7-bbf43d6e863c",
                date: watchConfig.date,
                identifyAllPlayers: true
            })
        });

        const data = await response.json();
        
        if (!data.slots) {
            console.log("Inga slots hittades.");
            return;
        }

        const availableSlots = data.slots.filter(slot => {
            const slotTime = slot.time.split("T")[1].substring(0, 5);
            return slotTime >= watchConfig.from && 
                   slotTime <= watchConfig.to && 
                   slot.availablity.bookable;
        });

        if (availableSlots.length > 0) {
            const foundTime = availableSlots[0].time.split("T")[1].substring(0, 5);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TEE TIME HITTAD!",
                html: `<h1>Tid hittad: ${foundTime}</h1>`
            });
            stopJob();
            status = `Klar! Hittade ${foundTime}`;
        } else {
            status = "Bevakning aktiv: Inga lediga tider än...";
        }

    } catch (err) {
        console.error("API-fel:", err.message);
        status = "Fel: " + err.message;
    }
}

function stopJob() {
    if (job) job.stop();
    watchConfig = null;
}

app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Startar...";
    if (job) job.stop();
    checkTimes();
    job = cron.schedule("*/1 * * * *", checkTimes); // Vi kan köra varje minut nu eftersom det är så lätt!
    res.sendStatus(200);
});

app.get("/status", (req, res) => { res.json({ status }); });

app.listen(3000, () => console.log("API Server redo"));