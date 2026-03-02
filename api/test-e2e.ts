import { agentRoutes } from "./src/routes/agent.routes";
import { Hono } from "hono";

// Wrap agentRoutes in a base app to simulate the full path
const app = new Hono();
app.route("/api/agent", agentRoutes);

async function runTest() {
    console.log("SENDING REQUEST TO agentRoutes...\n");

    const req = new Request("http://localhost/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            question: "Tell me about the performance of user ID 2388 (Abinaya A)? Give me a complete profile.",
            user_id: 35,
            user_role: 7
        })
    });

    const res = await app.request(req);
    console.log("STATUS:", res.status);
    const data = await res.json();

    console.log("\n==== FINAL REPORT ====\n");
    console.log(data.report || data.error);

    console.log("\n==== METADATA ====\n");
    console.log("Steps:", data.steps);
    if (data.sql) console.log("Final Executed SQL:", data.sql);
}

runTest().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
