import fs from 'fs';

const questions = [
    "how many students in my college?",
    "show department wise student count",
    "how are my students performing?",
    "gender distribution of my students",
    "how many trainers in my college?",
    "how many courses allocated to my college?",
    "top 5 students in my college",
    "how many students in each batch?",
    "who am I?",
    "what is my college name?",
    "how many courses are available?",
    "how many colleges are there?",
    "how many students in SREC?",
    "compare SKCET vs SREC",
    "top 10 students across all colleges"
];

const PORT = 8081;
const USER_ID = 6818;
const USER_ROLE = 3;

async function runTests() {
    let output = "=== College Admin User (User ID: " + USER_ID + ", Role: " + USER_ROLE + ") TEST RESULTS (" + new Date().toISOString() + ") ===\n\n";
    output += "Using: http://localhost:" + PORT + "/api/agent/chat\n";
    output += "====================================================================\n\n";

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        console.log("[" + (i + 1) + "/" + questions.length + "] Testing: " + q);
        output += "Q" + (i + 1) + ": " + q + "\n";

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout

            const res = await fetch("http://localhost:" + PORT + "/api/agent/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    question: q,
                    user_id: USER_ID,
                    user_role: USER_ROLE
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            const data = await res.json();

            output += "Report:\n" + (data.report || "No report") + "\n\n";
            output += "SQL Executed: " + (data.sql ? data.sql.trim().replace(/\n/g, ' ') : "None") + "\n";
            output += "Tokens: " + data.inputToken + " in / " + data.outputToken + " out | Time: " + data.responseTimeSec + "s\n";
            output += "--------------------------------------------------\n\n";

        } catch (err) {
            console.error("Failed on " + q + ": " + err.message);
            output += "ERROR: " + err.message + "\n";
            output += "--------------------------------------------------\n\n";
        }

        fs.writeFileSync('C:/Users/Admin/Documents/mono-master/mono-master/collegeadmin_test_results.txt', output, 'utf8');
    }

    console.log("College Admin testing complete! Results written to collegeadmin_test_results.txt");
}

runTests();
