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
    res.send("<h1>TeePilot API v3</h1><p>Status: " + status + "</p>");
});

async function checkTimes() {
    if (!watchConfig) return;

    try {
        console.log(`[${new Date().toLocaleTimeString()}] Loggar in på Min Golf...`);
        
        // 1. LOGGA IN (Den nya Identity-vägen)
        const loginRes = await fetch("https://mingolf.golf.se/api/v1/auth/login", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "accept": "application/json",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({
                username: watchConfig.golfId,
                password: watchConfig.password
            })
        });

        if (!loginRes.ok) {
            // Om v1 inte funkar, testar vi den gamla vägen automatiskt som backup i samma anrop
            const backupRes = await fetch("https://mingolf.golf.se/api/login", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username: watchConfig.golfId, password: watchConfig.password })
            });
            if (!backupRes.ok) throw new Error(`Inloggning misslyckades (${loginRes.status})`);
            var finalRes = backupRes;
        } else {
            var finalRes = loginRes;
        }
        
        const setCookie = finalRes.headers.get("set-cookie");
        if (!setCookie) throw new Error("Fick ingen session (cookie saknas)");

        console.log("Inloggning lyckades! Söker tider på Vasatorp...");

        // 2. HÄMTA TIDERNA (Tournament Course ID: 0abbcc77-25a8-4167-83c7-bbf43d6e863c)
        const response = await fetch("https://mingolf.golf.se/api/v1/booking/slots", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "cookie": setCookie,
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            },
            body: JSON.stringify({
                courseId: "0abbcc77-25a8-4167-83c7-bbf43d6e863c",
                date: watchConfig.date
            })
        });

        const data = await response.json();
        
        // Hantera olika format på API-svaret
        const slots = data.slots || data.items || [];

        const availableSlots = slots.filter(slot => {
            const slotTime = slot.time.includes("T") ? slot.time.split("T")[1].substring(0, 5) : slot.time;
            const isBookable = slot.isBookable || (slot.availability && slot.availability.bookable);
            return slotTime >= watchConfig.from && slotTime <= watchConfig.to && isBookable;
        });

        if (availableSlots.length > 0) {
            const foundTime = availableSlots[0].time.includes("T") ? availableSlots[0].time.split("T")[1].substring(0, 5) : availableSlots[0].time;
            console.log("HITTADE TID:", foundTime);
            
            await resend.emails.send({
                from: "TeePilot <onboarding@resend.dev>",
                to: [watchConfig.email],
                subject: "TEE TIME HITTAD!",
                html: `<h2>En ledig tid kl ${foundTime} hittades!</h2><p>Datum: ${watchConfig.date}</p><p><a href="https://mingolf.golf.se/bokning">Gå till Min Golf</a></p>`
            });
            
            stopJob();
            status = `Klar! Hittade ${foundTime}`;
        } else {
            status = "Bevakning aktiv: Inga lediga tider än...";
        }

    } catch (err) {
        console.error("Fel:", err.message);
        status = "Väntar på nästa försök: " + err.message;
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