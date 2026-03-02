const fetch = require('node-fetch');

async function test() {
  try {
    const response = await fetch('http://localhost:8081/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: "how many students are there?",
        format: "text",
        user_id: 35,
        user_role: 7
      })
    });
    const text = await response.text();
    console.log('--- API RESPONSE ---');
    console.log(text);
    console.log('--------------------');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
