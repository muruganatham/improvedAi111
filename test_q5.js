const q5 = "what is my rank in Data Structures?";

async function main() {
    console.log(`Sending: ${q5}`);
    try {
        const res = await fetch('http://localhost:8081/api/agent/chat', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                question: q5,
                user_id: 902,
                user_role: 7,
            }),
        });
        const d = await res.json();
        console.log('Seconds:', d.responseTimeSec, 'Steps:', d.steps, 'SQL:', d.sql, 'Report:', d.report)
    } catch (e) {
        console.error(e);
    }
}

main();
