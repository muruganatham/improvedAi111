const url = 'http://localhost:8081/api/agent/chat';

async function testJeevaFast() {
    console.log('Sending search query (Expect 1-2 steps maximum):');
    const t0 = Date.now();
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            question: 'who is jeevanantham?',
            user_id: 2,
            topic_id: 1,
            category: 'search',
            thread_id: 'test-jeeva-fast'
        })
    });
    const data = await res.json();
    console.log(`Time: ${Date.now() - t0}ms, Response: ${JSON.stringify(data).slice(0, 150)}...`);
}

async function testAdmins() {
    console.log('\nSending admin count query (Expect precisely 14):');
    const t0 = Date.now();
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            question: 'how many admins are there in the system?',
            user_id: 3,
            topic_id: 1,
            category: 'analytics',
            thread_id: 'test-admin-count'
        })
    });
    const data = await res.json();
    console.log(`Time: ${Date.now() - t0}ms, Response: ${JSON.stringify(data).slice(0, 150)}...`);
}

async function testDeduplicator() {
    console.log('\nSending 2 identical rapid requests (Expect first 200, second 429):');
    const payload = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            question: 'testing duplicate limits',
            user_id: 1,
            topic_id: 1,
            category: 'search',
            thread_id: 'test-dupe'
        })
    };

    const [res1, res2] = await Promise.all([
        fetch(url, payload),
        fetch(url, payload)
    ]);

    console.log(`Req 1: ${res1.status}, Req 2: ${res2.status}`);
}

async function run() {
    await testDeduplicator();
    await testJeevaFast();
    await testAdmins();
}

run();
