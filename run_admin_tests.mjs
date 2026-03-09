import fs from 'fs';

const questions = [
    "how many students are there?",
    "compare SKCET vs SREC student count",
    "top 5 students across all colleges",
    "how many students in SKCT?",
    "which department has most students?",
    "how many trainers are there?",
    "how many courses allocated?",
    "find student Rakshitha",
    "show college wise student count",
    "gender distribution across all colleges",
    "how many inactive students?",
    "who am I?",
    "how many courses are available?",
    "evalo students iruku?",
    "what is my password?"
];

const PORT = 8081;
const USER_ID = 2;
const USER_ROLE = 1;

async function runTests() {
    let output = "=== Admin User (User ID: " + USER_ID + ", Role: " + USER_ROLE + ") TEST RESULTS (" + new Date().toISOString() + ") ===\n\n";
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

        fs.writeFileSync('C:/Users/Admin/Documents/mono-master/mono-master/admin_test_results.txt', output, 'utf8');
    }

    console.log("Admin testing complete! Results written to admin_test_results.txt");
}

runTests();
