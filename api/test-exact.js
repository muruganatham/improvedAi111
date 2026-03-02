const http = require('http');

const data = JSON.stringify({
  question: "how many students are there?",
  format: "text",
  raw: true,
  user_id: 35,
  user_role: 7,
  chatId: "65d3a2e3f5b7a1c4d9e8f0a1"
});

const options = {
  hostname: 'localhost',
  port: 8081,
  path: '/api/agent/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('--- FINAL RESPONSE ---');
    console.log(body);
    console.log('--------------------');
  });
});

req.on('error', (e) => {
  console.error(`Error: ${e.message}`);
});

req.write(data);
req.end();
