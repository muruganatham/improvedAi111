const { checkRestrictedAccess } = require('./api/src/agent-lib/role-access.ts');

async function runTests() {
  console.log("--- SECURE COLLEGE ACCESS TESTS ---");
  const roleNum = 3; // College Admin

  const questions = [
    "Top 10 students", // Allowed
    "Student progress in DS", // Allowed
    "Compare our college with SREC", // Blocked by L2.5
    "Total students on platform", // Blocked by L2.5
    "List all colleges" // Blocked by L2.5
  ];

  for (const q of questions) {
    const res = checkRestrictedAccess(q, roleNum, 'college');
    console.log(`Q: "${q}"\n   L2.5 Instant Block: ${!res.allowed ? 'BLOCKED - ' + res.reason : 'PASSED'}\n`);
  }
}

runTests();
