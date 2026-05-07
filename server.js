const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, 
    auth: {
        user: "teepilot2026@gmail.com",
        pass: "tfyjmolzgyynedzo"
    },
    connectionTimeout: 10000,
    socketTimeout: 10000,
    dnsTimeout: 10000,
    family: 4 
});

const app = express();
app.use(cors());
app.use(express.json());

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
        
        const { golfId, password, date, from, to, email, courseId } = watchConfig;

        await jar.removeAllCookies();

        await client.post("/login/api/Users/Login", {
            GolfId: golfId,
            Password: password
        }, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://mingolf.golf.se/login/'
            }
        });

        const targetCourse = courseId || "0abbcc77-25a8-4167-83c7-bbf43d6e863c";

        const scheduleRes = await client.get(`/bokning/api/Clubs/${VASATORP_CLUB_ID}/CourseSchedule`, {
            params: { courseId: targetCourse, date: date }
        });

        let allSlots = Array.isArray(scheduleRes.data) ? scheduleRes.data : (scheduleRes.data?.slots || []);
        const availableSlots = [];

        allSlots.forEach(slot => {
            if (!slot.time || !slot.availablity) return;

            const timePart = slot.time.split("T")[1]; 
            const utcHour = parseInt(timePart.split(":")[0], 10);
            
            const slotHourSwe = utcHour + 2;
            const targetFrom = parseInt(from, 10);
            const targetTo = parseInt(to, 10);

            if (slotHourSwe >= targetFrom && slotHourSwe <= targetTo) {
                const isBookable = slot.availablity.bookable;
                const availableSpaces = slot.availablity.availableSlots;
                const isLocked = slot.isLocked;

                const minutes = timePart.split(":")[1];
                const displayTimeSwe = `${slotHourSwe.toString().padStart(2, '0')}:${minutes}`;

                if (isBookable && !isLocked && availableSpaces === 4) {
                    console.log(`KONTROLL: ${displayTimeSwe} har 4 lediga platser - SPARAR!`);
                    availableSlots.push(displayTimeSwe);
                }
            }
        });

        if (availableSlots.length > 0) {
            const timeList = availableSlots.join(", ");
            
            let courseName = "Okänd bana";
            if (targetCourse === "59279f96-b573-4dcb-9d9b-8fa6c3bf644e") {
                courseName = "Classic Course";
            } else if (targetCourse === "0abbcc77-25a8-4167-83c7-bbf43d6e863c") {
                courseName = "Tournament Course";
            } else if (targetCourse === "aaa98917-7e69-4f2b-8eaf-0ed7956ebf00") {
                courseName = "Park Course";
            }
            
            console.log(`MATCHADE TIDER: ${timeList} på ${courseName}`);

            try {
                const mailOptions = {
                    from: '"TeePilot" <teepilot2026@gmail.com>',
                    to: email,
                    subject: `Ledig 4-boll på ${courseName}!`,
                    html: `
                        <div style="font-family: Arial, sans-serif; border: 1px solid #ddd; padding: 20px;">
                            <h2 style="color: #2e7d32;">Match funnen! ⛳</h2>
                            <p>Den <b>${date}</b> finns lediga 4-bollar på <b>${courseName}</b>.</p>
                            <p><b>Tillgängliga tider:</b> ${timeList}</p>
                            <p>Skynda dig att boka i MinGolf!</p>
                        </div>
                    `
                };

                await transporter.sendMail(mailOptions);
                console.log("Mail skickat via Nodemailer!");
            } catch (mailErr) {
                console.error("Mailfel:", mailErr.message);
            }

            status = `Match funnen! Mail skickat till ${email} för: ${timeList} på ${courseName}`;
            stopEverything();
        } else {
            status = `Sökt ${new Date().toLocaleTimeString('sv-SE')}: Inga lediga 4-bollar hittade.`;
            console.log(status);
        }

    } catch (err) {
        console.error("Fel vid sökning:", err.message);
        status = "Kunde inte ansluta till MinGolf.";
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
    status = `Bevakar ${watchConfig.date} på vald bana...`;
    
    checkTimes();
    
    job = cron.schedule("*/5 * * * *", checkTimes);
    res.sendStatus(200);
});

app.post("/stop", async (req, res) => {
    await stopEverything();
    status = "Ingen aktiv bevakning";
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TeePilot Server aktiv på port ${PORT}`));