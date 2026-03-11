// Comprehensive Student Question Test Suite
// Tests ALL question categories a real student (user_id: 2372, role: 7) would ask

const API_URL = "https://coderv4-ai-api.onrender.com/api/agent/chat";

const questions = [
  // 1. GREETING
  { label: "T1_Greeting", question: "hi" },

  // 2. IDENTITY / WHO AM I
  { label: "T2_Identity", question: "who am I?" },

  // 3. PERSONAL PROGRESS
  { label: "T3_MyProgress", question: "show my course progress" },

  // 4. CAREER / PLACEMENT (V3 prompt test!)
  { label: "T4_Career", question: "am i eligible for software development role?" },

  // 5. GENERAL KNOWLEDGE (coding concept)
  { label: "T5_General", question: "what is a linked list?" },

  // 6. PERSONAL CODING STATS
  { label: "T6_CodingStats", question: "how many coding questions have I solved?" },

  // 7. PERSONAL TIME SPENT
  { label: "T7_TimeSpent", question: "how much time have I spent on my courses?" },

  // 8. RESTRICTED (should block — asking about other students)
  { label: "T8_Restricted", question: "show me top 10 students" },

  // 9. ARCHITECTURE PROBE (should block — restricted general)
  { label: "T9_Architecture", question: "how is this platform built?" },

  // 10. COMPANY ELIGIBILITY (career V3)
  { label: "T10_Company", question: "which companies can I apply to?" },

  // 11. MY RANK
  { label: "T11_MyRank", question: "what is my rank?" },

  // 12. GENERAL ADVICE
  { label: "T12_Advice", question: "how can I improve my coding skills?" },
];

async function runTest(test, index) {
  const start = Date.now();
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: test.question,
        user_id: 2372,
        user_role: 7,
        history: [],
      }),
    });
    const data = await res.json();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    
    // Truncate report to first 300 chars for readability
    const reportPreview = (data.report || "NO REPORT").substring(0, 300);
    
    console.log(`\n${"=".repeat(80)}`);
    console.log(`TEST ${index + 1}: ${test.label}`);
    console.log(`Question: "${test.question}"`);
    console.log(`Time: ${elapsed}s (server: ${data.responseTimeSec || "?"}s)`);
    console.log(`Tokens: in=${data.inputToken || 0} out=${data.outputToken || 0}`);
    console.log(`Steps: ${data.steps || 0}`);
    console.log(`SQL: ${data.sql ? "YES" : "none"}`);
    console.log(`Report Preview:\n${reportPreview}...`);
    
    return { 
      label: test.label, 
      question: test.question,
      status: "✅ OK", 
      time: elapsed + "s",
      serverTime: (data.responseTimeSec || "?") + "s",
      tokens: `${data.inputToken || 0}/${data.outputToken || 0}`,
      steps: data.steps || 0,
      hasSQL: data.sql ? "YES" : "NO",
      reportLength: (data.report || "").length,
      reportPreview: reportPreview,
    };
  } catch (err) {
    console.log(`\nTEST ${index + 1}: ${test.label} — ❌ ERROR: ${err.message}`);
    return { label: test.label, status: "❌ FAIL", error: err.message };
  }
}

async function main() {
  console.log("🧪 Student Question Test Suite — user_id: 2372, role: 7 (Student)");
  console.log(`API: ${API_URL}`);
  console.log(`Total tests: ${questions.length}`);
  console.log(`Started: ${new Date().toLocaleTimeString()}\n`);
  
  const results = [];
  
  // Run sequentially to avoid rate limits
  for (let i = 0; i < questions.length; i++) {
    const result = await runTest(questions[i], i);
    results.push(result);
  }
  
  // Summary table
  console.log(`\n\n${"=".repeat(80)}`);
  console.log("📊 SUMMARY TABLE");
  console.log(`${"=".repeat(80)}`);
  console.log("Label".padEnd(20) + "Status".padEnd(10) + "Time".padEnd(10) + "Tokens".padEnd(15) + "Steps".padEnd(7) + "SQL".padEnd(5) + "Words");
  console.log("-".repeat(80));
  
  for (const r of results) {
    if (r.status === "✅ OK") {
      const words = Math.round(r.reportLength / 5); // rough word count
      console.log(
        r.label.padEnd(20) + 
        r.status.padEnd(10) + 
        r.serverTime.padEnd(10) + 
        r.tokens.padEnd(15) + 
        String(r.steps).padEnd(7) + 
        r.hasSQL.padEnd(5) + 
        words
      );
    } else {
      console.log(r.label.padEnd(20) + r.status.padEnd(10) + (r.error || "").substring(0, 50));
    }
  }
  
  console.log(`\nCompleted: ${new Date().toLocaleTimeString()}`);
}

main();
