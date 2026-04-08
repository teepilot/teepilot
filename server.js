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
    res.send("<h1>TeePilot API v2</h1><p>Status: " + status + "</p>");
});

async function checkTimes() {
    if (!watchConfig) return;

    try {
        console.log(`[${new Date().toLocaleTimeString()}] Försöker logga in...`);
        
        // 1. LOGGA IN (Nya korrekta URL-vägen)
        const loginRes = await fetch("https://mingolf.golf.se/api/session/login", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "accept": "application/json",
                "origin": "https://mingolf.golf.se",
                "referer": "https://mingolf.golf.se/Login",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({
                loginId: watchConfig.golfId, // Notera: loginId istället för username
                password: watchConfig.password,
                rememberMe: false
            })
        });

        if (!loginRes.ok) {
            throw new Error(`Inloggning nekad (Status: ${loginRes.status})`);
        }
        
        // Hämta session-cookien (Viktigt!)
        const setCookie = loginRes.headers.get("set-cookie");
        if (!setCookie) throw new Error("Fick ingen session från Min Golf");

        console.log("Inloggning lyckades! Letar tider...");

        // 2. HÄMTA TIDERNA
        const response = await fetch("https://mingolf.golf.se/api/booking/get-slots", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "cookie": setCookie,
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({
                clubId: "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a",
                courseId: "0abbcc77-25a8-4167-83c7-bbf43d6e863c",
                date: watchConfig.date
            })
        });

        const data = await response.json();
        
        if (!data.slots || !Array.isArray(data.slots)) {
            console.log("Inga tider tillgängliga.");
            return;
        }

        const availableSlots = data.slots.filter(slot => {
            // Min Golf API returnerar oftast tid som "08:10" eller full ISO sträng
            const slotTime = slot.time.includes("T") ? slot.time.split("T")[1].substring(0, 5) : slot.time;
            return slotTime >= watchConfig.from && 
                   slotTime <= watchConfig.to && 
                   slot.isBookable;
        });

        if (availableSlots.length > 0) {
            const foundTime = availableSlots[0].time;
            console.log("HITTADE TID:", foundTime);
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TEE TIME HITTAD!",
                html: `<h1>Tid hittad: ${foundTime}</h1><p>Boka nu!</p>`
            });
            stopJob();
            status = `Hittad: ${foundTime}. Bevakning avslutad.`;
        } else {
            status = "Bevakning aktiv: Söker...";
        }

    } catch (err) {
        console.error("Fel:", err.message);
        status = "Fel: " + err.message;
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