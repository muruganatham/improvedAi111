// Removing node-fetch import, using native fetch
async function testWhoAmI() {
    const url = 'http://localhost:8081/api/agent/chat';
    const body = {
        question: "who am i",
        user_id: 9239,
        user_role: 2
    };

    console.log('Testing "who am i" fast-path...');
    const start = Date.now();

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await res.json();
        const duration = Date.now() - start;

        console.log('Response Time:', duration, 'ms');
        console.log('Steps:', data.steps);
        console.log('Report Header:', data.report.split('\n')[0]);

        if (data.steps === 0) {
            console.log('✅ SUCCESS: Fast-path triggered (0 steps)');
        } else {
            console.log('❌ FAILURE: LLM was called (steps > 0)');
        }
    } catch (err) {
        console.error('Test failed:', err.message);
    }
}

testWhoAmI();
