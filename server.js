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

async function sendEmail(to, time) {
    try {
        await resend.emails.send({
            from: "TeePilot <onboarding@resend.dev>",
            to: [to],
            subject: "TEE TIME HITTAD!",
            html: `<h1>En tid har hittats!</h1><p>Tid: <strong>${time}</strong></p><p>Skynda dig till Min Golf!</p>`
        });
        console.log("Mejl skickat!");
    } catch (error) {
        console.error("Mejlfel:", error);
    }
}

async function checkTimes() {
    if (!watchConfig) return;

    try {
        console.log(`Kollar tider för ${watchConfig.date}...`);

        const response = await fetch("https://mingolf.golf.se/sysadmin/api/visit/bokning", {
            method: "POST",
            headers: {
                "accept": "application/json, text/plain, */*",
                "content-type": "application/json; charset=utf-8",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
                "referer": "https://mingolf.golf.se/bokning/",
                // KLISTRA IN DIN COOKIE HÄR:
                "cookie": "CookieConsent={stamp:%27O8ysKsT0zuLA9thiffhPEygsxlySCNNWwnIwzZ6YySIHPD7aIpJmNQ==%27%2Cnecessary:true%2Cpreferences:false%2Cstatistics:false%2Cmarketing:false%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1773306983188%2Cregion:%27se%27}; __eoi=ID=8ed616c3daff8ff8:T=1773306984:RT=1775637192:S=AA-AfjZbWjQFgN_1pu4jWKr4I3OA; mgat=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uSWQiOiJlMjBiNmJkNi0wYWUwLTRiOGMtODUxMy03MWU2Zjg0NDI5NjUiLCJwZXJzb25JZCI6IjE4NTVlMTc2LThjZGYtNGM2MS1hNWRjLTllNmFhODA0MDJiYyIsImZpcnN0TmFtZSI6Ik5lbyIsImxhc3ROYW1lIjoiQ2FybHNzb24iLCJnb2xmSWQiOiIwNzEyMDEtMDA3IiwiaG9tZUNsdWJJZCI6ImYyY2IwZjE5LTU1OGQtNDAyOS04ZGM2LTBkMzM0MGM2ZWIxYSIsImhvbWVDbHViTmFtZSI6IlZhc2F0b3JwcyBHb2xma2x1YmIiLCJkaXN0cmljdE5hbWUiOiJTa8OlbmVzIEdERiIsInJlcHJlc2VudGF0aW9uQ2x1Yk5hbWUiOiIiLCJyZXByZXNlbnRhdGlvbkNsdWJTaG9ydCI6IiIsImZhdm91cml0ZUNsdWJJZCI6ImYyY2IwZjE5LTU1OGQtNDAyOS04ZGM2LTBkMzM0MGM2ZWIxYSIsImdlbmRlciI6Ik1hbGUiLCJiaXJ0aERhdGUiOiIyMDA3LTEyLTAxIiwiYWdlIjoiMTkiLCJoY3AiOiI0LDciLCJpc01pbm9yIjoiZmFsc2UiLCJpc01pbm9yV2l0aG91dENhcmVnaXZlciI6ImZhbHNlIiwiYWxsb3dlZFRvQm9vayI6InRydWUiLCJhbGxvd2VkVG9Cb29rV2l0aE5vQ2hhcmdlIjoiZmFsc2UiLCJhbGxvd2VkVG9Db21wZXRpdGlvblNpZ25VcCI6InRydWUiLCJhbGxvd2VkVG9Db21wZXRpdGlvblNpZ25VcE5vQ2hhcmdlIjoiZmFsc2UiLCJhbGxvd2VkVG9QYXkiOiJ0cnVlIiwiZW1haWxBZGRyZXNzIjoiY2FybHNzb25uZW9AaG90bWFpbC5jb20iLCJoYXNBY3RpdmVNZW1iZXJzaGlwIjoidHJ1ZSIsImxvZ2dlZEluVG9NaW5Hb2xmVGhpc1llYXIiOiJ0cnVlIiwibWlub3JzIjoiIiwibWVtYmVyQ2x1YnMiOiJbe1wiaXNIb21lQ2x1YlwiOnRydWUsXCJpZFwiOlwiZjJjYjBmMTktNTU4ZC00MDI5LThkMzM0MGM2ZWIxYSIsImNhcmVnaXZlclBlcnNvbklkIjoiIiwiY2FyZWdpdmVyR29sZklkIjoiIiwiaW1hZ2VVcmwiOiJodHRwczovL2dvY2Ruc3RvcmFnZS5ibG9iLmNvcmUud2luZG93cy5uZXQvc2dmYm9va2luZ2FwcC9wcmQvcHJvZmlsZS8xODU1ZTE3Ni04Y2RmLTRjNjEtYTVkYy05ZTZhYTgwNDAyYmMuanBnP3JhbmQ9NjM5MTEyNDg3MTIzNDU5NDE2IiwiaXNEZWZhdWx0U3VwcG9ydCI6ImZhbHNlIiwiaXNGZWRlcmF0aW9uU3VzcGVuZGVkIjoiZmFsc2UiLCJpc0ZlZGVyYXRpb25TdXNwZW5kZWRDb21wZXRpdGlvbiI6ImZhbHNlIiwiaGNwQ2FyZCI6ImFtYXRldXIiLCJjYXBwZWQiOiJmYWxzZSIsImxvd2VzdEhjcCI6IjQsNCIsInNvZnRDYXAiOiIiLCJoYXJkQ2FwIjoiIiwiaXNTZ2ZKdW5pb3IiOiJ0cnVlIiwiaXNNZW1iZXJPZlRlZW5Ub3VyQ2x1YiI6ImZhbHNlIiwiaGFzUGFpZFRlZW5Ub3VyWWVhcmx5RmVlIjoiZmFsc2UiLCJtdXN0Q2hhbmdlUGFzc3dvcmQiOiJmYWxzZSIsImlzTG9nZ2VkSW5XaXRoRnJlamEiOiJmYWxzZSIsImhhc0xvZ2dlZEluVG9NaW5Hb2xmVGhpc1llYXIiOiJ0cnVlIiwic2hvd1BlcnNvbkluZm9WaWV3IjoiZmFsc2UiLCJpc0ZvcmVpZ24iOiJmYWxzZSIsImNvdW50cnkiOiIiLCJ0b2tlbiI6ImV5SmhiR2NpT2lKU1V6STFOaUlzSW10cFpDSTZJbGcxWlZock5IaDViMnBPUm5WdE1XdHNNbGwwZGpoa2JFNVFOQzFqTlRka1R6WlJSMVJXUW5kaFRtc2lMQ0owZVhBaU9pSktWMVFpZlEuZXlKaGRXUWlPaUppWWpJelpHRmtPQzA1TlRkaExUUmlNekV0T0RObU5TMWtNR0k0TW1VNVlUVTNZemdpTENKcGMzTWlPaUpvZEhSd2N6b3ZMM05uWm1GMWRHaHdjbTlrTG1JeVkyeHZaMmx1TG1OdmJTODRNV0kxWkRVeU9DMWhOVGxoTFRRek5HTXRZakptWWkxa1kyWTVOV0ZtTWpnNFlUWXZkakl1TUM4aUxDSmxlSEFpT2pFM056VTNNemM1T1RVc0ltNWlaaUk2TVRjM05UWTFNVFU1TlN3aWRHWndJam9pUWpKRFh6RmZRWFYwYUZCeWIyUWlMQ0p6WTNBaU9pSnhZVEU0TUdRMU1ERXRORFEzWVMwME9UZ3hMVGt4WWprdE0yTTRNRFZsTURkaFpXVmlJaXdpYVdGMElqb3hOemM1TmpJM09Ua2ZRLkRjamJ1aU5qT1gzR0JhQ0l3RFI2NGxQWFprU3RCUGV4NFgtSmZubHFSSVk0X1phSkdSUHY1OW5nQk5CRS1lY1c4RVJOU180VUxzN3RsUjNzRWhCbnEyWTdMZVhYZWM3NHM3RmhEUmRzeXBXdFNOZlI4eHFkMFhqd0JzSG8xU0JBS21yYkM2RW8tSEJUQXRpNGFZLVdBaVFUbUlJUjZJbXUwQjlVMF9iQ3h3UTg3MVBSbHluV2diMXlHcmgtWFFMQldULV9qVkV5MzE2M3JISEV0b0FyQ2ZSbG5uSFRXSmtidm1ranctOFlfazFFZll6em1sNmhRbG1odTRiYnZFNmVoMUhaeUlJY1p0N0x3aS1NRnBWUFFCZUVWU05VUmhYTEM3V195YmZxaWctTjd5c1hueGFuUjBlenhGQ0FIdXdMenZUY3N1OVRjUkpVOTZyTTU0cmNwdyIsImV4cCI6MTc3NTY5Mjc5OSwiaXNzIjoibWluLWdvbGYifQ.1PpKasqlblKehcRK3axjchpsFFMxJwufFfnmglg4ui4"
            },
            body: JSON.stringify({
                clubId: "f2cb0f19-558d-4029-8dc6-0d3340c6eb1a",
                courseId: "0abbcc77-25a8-4167-83c7-bbf43d6e863c",
                date: watchConfig.date,
                identifyAllPlayers: true
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP Fel: ${response.status}`);
        }

        const text = await response.text();
        if (!text || text.trim().length === 0) {
            throw new Error("Tomt svar från Min Golf (cookien har troligen dött)");
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error("Kunde inte tolka JSON-svar");
        }

        if (!data.slots) {
            console.log("Inga tider tillgängliga i datan.");
            return;
        }

        const availableSlots = data.slots.filter(slot => {
            const slotTime = slot.time.split("T")[1].substring(0, 5);
            const isWithinTime = slotTime >= watchConfig.from && slotTime <= watchConfig.to;
            const isBookable = slot.availablity && slot.availablity.bookable;
            return isWithinTime && isBookable;
        });

        if (availableSlots.length > 0) {
            const foundTime = availableSlots[0].time.split("T")[1].substring(0, 5);
            console.log("MATCH HITTAD:", foundTime);
            await sendEmail(watchConfig.email, foundTime);
            
            if (job) job.stop();
            watchConfig = null;
            status = `Tid hittad: ${foundTime}. Bevakning klar!`;
        } else {
            console.log("Sökning utförd: Inga matchningar än.");
            status = "Bevakning aktiv: Söker...";
        }

    } catch (err) {
        console.error("!!! STOPPAR BEVAKNING PÅ GRUND AV FEL:", err.message);
        status = "Stoppad: " + err.message;
        if (job) job.stop();
        watchConfig = null;
    }
}

// ENDPOINTS
app.post("/start", (req, res) => {
    watchConfig = req.body;
    status = "Bevakning startad";
    if (job) job.stop();
    checkTimes(); // Kör direkt
    job = cron.schedule("*/30 * * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", (req, res) => {
    if (job) job.stop();
    watchConfig = null;
    status = "Bevakning stoppad manuellt";
    res.sendStatus(200);
});

app.get("/status", (req, res) => {
    res.json({ status });
});

app.listen(3000, () => console.log("Server online på port 3000"));