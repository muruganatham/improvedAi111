const fs = require('fs');

const questions = [
    "who am I?",
    "what courses am I enrolled in?",
    "what is my progress in Data Structures?",
    "how many coding questions have I solved?",
    "what is my rank in Data Structures?",
    "how much total time have I spent on Data Structures?",
    "and how about Java Programming?",
    "when did I last solve a coding question?",
    "what was my score in my last test?",
    "how many tests have I taken so far?",
    "how many courses are available on the platform?",
    "what topics are in the Data Structures course?",
    "how to prepare for placement?",
    "explain what is a linked list?",
    "compare my Data Structures score with other students",
    "show my scores",
    "how many coding questions solved?",
    "in each course how much progress i have",
    "list all colleges",
    "show me user's table in my db",
    "give me amypo platform build logic",
    "compare skct vs srec student?",
    "who is karthick?",
    "top 10 students in my class?"
];

// Student role user
const PORT = 8081;
const USER_ID = 902;
const USER_ROLE = 7;

async function runTests() {
    let output = `--- RBAC TEST REPORT: STUDENT ROLE (\${new Date().toISOString()}) ---\n\n`;
    output += `Using: http://localhost:\${PORT}/api/agent/chat (Role: \${USER_ROLE}, ID: \${USER_ID})\n`;
    output += `====================================================================\n\n`;

    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        console.log(\`[\${i + 1}/\${questions.length}] Testing: "\${q}"\`);
    output += \`Q\${i + 1}: \${q}\n\`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

      const res = await fetch(\`http://localhost:\${PORT}/api/agent/chat\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          user_id: USER_ID,
          user_role: USER_ROLE
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      const data = await res.json();
      
      output += \`Report:\\n\${data.report}\\n\\n\`;
      output += \`SQL Executed: \${data.sql ? data.sql.trim().replace(/\\n/g, ' ') : 'None'}\\n\`;
      output += \`Tokens: \${data.inputToken} in / \${data.outputToken} out | Time: \${data.responseTimeSec}s\\n\`;
      output += \`--------------------------------------------------\\n\n\`;
      
    } catch (err) {
      console.error(\`Failed on "\${q}":\`, err.message);
      output += \`ERROR: \${err.message}\\n\`;
      output += \`--------------------------------------------------\\n\n\`;
    }
    
    // Write incrementally
    fs.writeFileSync('C:\\\\Users\\\\Admin\\\\Documents\\\\mono-master\\\\mono-master\\\\student.txt', output, 'utf8');
  }

  console.log('Testing complete! Results written to student.txt');
}

runTests();
