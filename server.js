const { Resend } = require("resend");
const resend = new Resend("re_LHA5wWw6_86BChTR6dCeieuj3W9y3z85U");
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

let job = null;
let watchConfig = null;
let status = "Ingen aktiv bevakning";

// Hjälpfunktion för att skicka mejl
async function sendEmail(to, time) {
    try {
        await resend.emails.send({
            from: "TeePilot <onboarding@resend.dev>",
            to: [to],
            subject: "TEE TIME HITTAD!",
            html: `<h1>En tid har hittats!</h1><p>Tid: <strong>${time}</strong></p><p>Gå till Min Golf och boka nu!</p>`
        });
        console.log("Mejl skickat!");
    } catch (error) {
        console.error("Mejlfel:", error);
    }
}

// Huvudfunktion som kollar tiderna (API-version)
async function checkTimes() {
    if (!watchConfig) return;

    try {
        console.log(`Kollar tider för ${watchConfig.date}...`);

        // Vi använder samma URL som i din skärmbild/fetch
        const response = await fetch("https://mingolf.golf.se/sysadmin/api/visit/bokning", {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json; charset=utf-8",
                "sec-fetch-mode": "cors"
            },
            body: JSON.stringify({
                clubId: "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a", // Vasatorp från din JSON
                courseId: "0abbcc77-25a8-4167-83c7-bbf43d6e863c", // Tournament Course
                date: watchConfig.date,
                identifyAllPlayers: true
            })
        });

        const data = await response.json();

        if (!data.slots) {
            console.log("Kunde inte hämta slots. Min Golf kanske nekar anropet.");
            return;
        }

        // Filtrera fram lediga tider inom ditt intervall
        const availableSlots = data.slots.filter(slot => {
            const slotTime = slot.time.split("T")[1].substring(0, 5); // Ex: "08:15"
            const isWithinTime = slotTime >= watchConfig.from && slotTime <= watchConfig.to;
            const hasSpace = slot.availablity.availableSlots > 0;
            const isBookable = slot.availablity.bookable === true;

            return isWithinTime && (hasSpace || isBookable);
        });

        if (availableSlots.length > 0) {
            const foundTime = availableSlots[0].time.split("T")[1].substring(0, 5);
            console.log("!!! TID HITTAD:", foundTime);
            
            await sendEmail(watchConfig.email, foundTime);
            status = `Tid hittad: ${foundTime}. Bevakning avslutad.`;
            
            if (job) job.stop();
            watchConfig = null;
        } else {
            console.log("Inga lediga tider matchade sökningen just nu.");
            status = "Bevakning aktiv: Letar efter tider...";
        }

    } catch (err) {
        console.error("API-fel:", err);
        status = "Fel vid kontakt med Min Golf";
    }
}

// ROUTES
app.post("/start", (req, res) => {
    watchConfig = req.body;
    console.log("Startar bevakning:", watchConfig);
    
    status = "Bevakning aktiv";
    
    if (job) job.stop();
    
    // Kör direkt en gång, sedan var 30:e sekund (API tål mycket mer än Puppeteer!)
    checkTimes();
    job = cron.schedule("*/30 * * * * *", checkTimes);

    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    if (job) job.stop();
    watchConfig = null;
    status = "Bevakning stoppad";
    res.sendStatus(200);
});

app.get("/status", (req, res) => {
    res.json({ status });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kör på port ${PORT}`));