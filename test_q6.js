const q6 = "how much total time have I spent on Data Structures?";

async function main() {
    console.log(`Sending: ${q6}`);
    try {
        const res = await fetch('http://localhost:8081/api/agent/chat', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                question: q6,
                user_id: 902,
                user_role: 7,
            }),
        });
        const d = await res.json();
        console.log("Response:", JSON.stringify(d, null, 2));
    } catch (e) {
        console.error("Fetch Error:", e);
    }
}

main();
