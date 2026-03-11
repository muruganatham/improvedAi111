const https = require('https');
const fs = require('fs');

async function makeRequest(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = JSON.stringify(bodyObj);
    
    // Choose http or https based on protocol
    const lib = url.protocol === 'https:' ? https : require('http');
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: JSON.parse(body) });
        } catch(e) {
          resolve({ status: res.statusCode, ok: false, error: 'Failed to parse JSON response', bodyText: body });
        }
      });
    });
    
    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
}

async function runTests() {
  const userId = 2372;
  const roleId = 7;
  const url = 'https://coderv4-ai-api.onrender.com/api/agent/chat';
  
  const questions = [
    "Who am I?",
    "What courses am I enrolled in?",
    "How many total badges do I have?",
    "How many coding questions have I solved so far?",
    "How much total time have I spent studying?",
    "What is my MCQ accuracy?",
    "Which topic am I weakest in?",
    "Explain binary search in simple terms",
    "What is my rank in Data Structures?",
    "How many easy, medium, and hard questions have I solved?",
    "What errors do I make most frequently?",
    "What is my progress in Java?",
    "Am I ready for TCS placement?",
    "What is my average time per coding question?",
    "Show me all students in my college",
    "How many tests have I taken?",
    "What should I focus on next?",
    "What is my register number?",
    "What is my test case pass rate?",
    "Which modules have I completed fully?",
    "Give me a complete dashboard of my performance",
    "What is the admin password?",
    "What is the difference between stack and queue?",
    "Which companies can I target with my current skills?",
    "Am I better at coding or MCQs?",
    "Do I have any certificates?",
    "On which days of the week do I study most?",
    "Show my topic-wise score breakdown",
    "How is this platform built?",
    "How can I improve my coding score?"
  ];

  console.log(`Starting run of ${questions.length} questions against ${url}...`);
  
  let results = "# V4 Test Suite Results\\n\\n";
  let passed = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`[${i+1}/${questions.length}] Testing: ${q}`);
    
    try {
      const start = Date.now();
      const response = await makeRequest(url, {
        user_id: userId,
        user_role: roleId,
        question: q,
        history: []
      });
      
      const timeMs = Date.now() - start;
      const data = response.data || {};
      
      const status = response.ok ? '✅ SUCCESS' : '❌ ERROR';
      if (response.ok) passed++;
      
      results += `## Q${i+1}: ${q}\\n`;
      results += `**Status:** ${status} (${timeMs}ms)\\n`;
      if (data.sql) results += `**SQL Executed:** \`${data.sql.trim().replace(/\\n/g, ' ')}\`\\n`;
      if (data.report) results += `**Response excerpt:**\\n${data.report.substring(0, 300)}...\\n`;
      if (data.error) results += `**Error:** ${data.error}\\n`;
      if (!response.ok && response.bodyText) results += `**Raw Error Body:** ${response.bodyText.substring(0, 100)}\\n`;
      results += `\\n---\\n\\n`;
      
      // Add a small delay between requests to avoid overwhelming the server
      await new Promise(r => setTimeout(r, 1000));
      
    } catch (err) {
      console.error(`Failed to execute: ${err.message}`);
      results += `## Q${i+1}: ${q}\\n**Status:** 💥 CRASH\\n**Error:** ${err.message}\\n\\n---\\n\\n`;
    }
  }

  results = `# Summary\\n**Passed:** ${passed}/${questions.length} (${Math.round(passed/questions.length*100)}%)\\n\\n` + results;
  fs.writeFileSync('v4-test-results.md', results);
  console.log('Finished testing! Results written to v4-test-results.md');
}

runTests();
