const http = require('http');

const data = JSON.stringify({
  question: "how many students are there?",
  format: "text",
  user_id: 35,
  user_role: 7
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
  res.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  res.on('end', () => {
    console.log('\n--- END OF STREAM ---');
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
