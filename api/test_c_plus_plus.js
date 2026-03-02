const url = 'http://localhost:8081/api/agent/chat';

async function testLeaderboard() {
    console.log('Sending search query: Who is the best performer in C++?');
    const t0 = Date.now();
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            question: 'Who is the best performer in C++?',
            user_id: 35,
            topic_id: 1,
            category: 'analytics',
            thread_id: 'test-cpp-leaderboard'
        })
    });
    const data = await res.json();
    console.log(`\nTime: ${Date.now() - t0}ms, Response:`);
    console.log(JSON.stringify(data, null, 2));
}

testLeaderboard();
