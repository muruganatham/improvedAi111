/**
 * Agent Routes — Hybrid LLM Routing Architecture
 *
 * POST /api/agent/chat
 *   preRouteQuestion() → "general" | "db"
 *   general → fast knowledge answer, no tools
 *   db      → createSqlOnlyTools + generateText({ maxSteps: 6 }) + report pass
 *
 * POST /api/agent/chat-v2
 *   Full 3-tool manual loop (kept for compatibility / debugging)
 *
 * Design: Approach 3 (Hybrid) as recommended.
 *   LLM decides WHICH tools to call once routed.
 *   No keyword fast-paths or mode switching inside.
 */

import { Hono } from "hono";
import { generateText, tool, stepCountIs } from "ai";
import { appendFileSync } from "fs";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { getAvailableModels } from "../agent-lib/ai-models";
import { databaseConnectionService } from "../services/database-connection.service";
import { getAllAgentMeta } from "../agents";
import { getFullSchemaPrompt } from "../agent-lib/tools/shared/schema-cache";
import { loggers } from "../logging";
import { getSmartRegistryContext } from "../agent-lib/smart-registry";
import { findMatchingTemplate } from "../agent-lib/query-templates";

// DeepSeek + AI SDK require at least one property in tool parameter schemas.
// An empty z.object({}) causes "Invalid prompt: messages do not match ModelMessage[] schema".
// Use this dummy schema for tools that take no meaningful input.
const emptySchema = z.object({ _unused: z.string().optional() });

const logger = loggers.agent();
export const agentRoutes = new Hono();

// ── DeepSeek model factory ────────────────────────────────────────────────────
function makeDeepSeekModel(modelName: "deepseek-chat" | "deepseek-reasoner" = "deepseek-chat") {
  const patchedFetch = async (url: string, options: any) => {
    if (options?.body) {
      try {
        const body = JSON.parse(options.body);
        if (Array.isArray(body.tools)) {
          body.tools = body.tools.map((t: any) => {
            if (t.type === "function" && t.function?.parameters && !t.function.parameters.type) {
              t.function.parameters.type = "object";
            }
            return t;
          });
          options.body = JSON.stringify(body);
        }
      } catch { /* not JSON */ }
    }
    return fetch(url, options);
  };

  const provider = createOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com",
    fetch: patchedFetch as any,
  });
  return provider.chat(modelName);
}

// ── Routes ────────────────────────────────────────────────────────────────────
agentRoutes.get("/models", (c) => c.json({ models: getAvailableModels() }));
agentRoutes.get("/agents", (c) => c.json({ agents: getAllAgentMeta() }));

// ── Deduplication middleware ───────────────────────────────────────────────────
const recentRequests = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 10_000;
  for (const [key, ts] of recentRequests.entries()) {
    if (ts < cutoff) recentRequests.delete(key);
  }
}, 30_000);

agentRoutes.use("/chat", async (c, next) => {
  if (c.req.method !== "POST") return next();
  try {
    const body = await c.req.raw.clone().json();
    const key = `${body.user_id}:${body.question}`;
    const now = Date.now();
    if (recentRequests.has(key) && now - recentRequests.get(key)! < 2000) {
      return c.json({ error: "Duplicate request. Please wait a moment." }, 429);
    }
    recentRequests.set(key, now);
  } catch { /* ignore */ }
  await next();
});

// ── Pre-router: classify question WITHOUT calling the LLM ────────────────────
// Returns "general" → answer from knowledge, no DB access needed
// Returns "db"      → needs real data from TiDB, use tools
function preRouteQuestion(q: string): "general" | "db" {
  const lower = q.toLowerCase().trim();

  // ── Signals that are clearly advice/general knowledge (check FIRST) ──
  const advicePatterns = [
    /\bhow to improve\b/, /\bhow can (they|we|i|he|she) improve\b/,
    /\brecommend(ation)?s?\b/, /\bsuggestion?s?\b/, /\btips?\b/,
    /\badvice\b/, /\bwhat should (they|we|i|he|she)\b/,
    /\bhow (to|can) (learn|study|practice|prepare|get better)\b/,
    /\bstrateg(y|ies)\b/, /\bhelp them\b/, /\bguide\b/,
    /\bbest (way|practice|approach|method) to\b/,
  ];

  const isAdvice = advicePatterns.some(p => p.test(lower));

  // If it's pure advice with no DB entity references, route to general
  if (isAdvice) {
    const platformTerms = /student|college|batch|enrolled|score|course|result|skcet|srec|mcet|kits|skct|skcet|niet|kclas|ciet/i;
    if (!platformTerms.test(lower)) return "general";
    // If it mentions platform entities, it might need DB context — fall through to DB patterns
  }

  // ── Signals that definitely need DB data ──
  const dbPatterns = [
    // Quantitative
    /\bhow many\b/, /\bcount\b/, /\btotal\b/, /\baverage\b/, /\bsum\b/,
    // Ranking / comparison
    /\bbest\b/, /\btop\b/, /\bworst\b/, /\branked?\b/, /\btopper\b/,
    /\bcompare\b/, /\bvs\b/, /\bversus\b/,
    // People / entities
    /\bstudent\b/, /\bcollege\b/, /\bcourse\b/, /\bbatch\b/, /\bstaff\b/,
    /\btrainer\b/, /\badmin\b/, /\benroll(ed|ment)?\b/,
    // Actions / data requests
    /\blist\b/, /\bshow\b/, /\bgive me\b/, /\bwho\b/, /\bwhich\b/,
    /\bfind\b/, /\bget\b/,
    // Metrics
    /\bscore\b/, /\bperform(ance|er)?\b/, /\bprogress\b/, /\bresult\b/,
    /\brank\b/, /\battend(ance)?\b/, /\bsubmission\b/,
    // Platform specifics
    /\bsrec\b/, /\bskcet\b/, /\bkits\b/, /\bmcet\b/, /\bdotlab\b/,
    /\bpython\b|\bjava\b|\bc\+\+\b|\bsql\b|\bdata science\b/,
    /\boverview\b/, /\bdashboard\b/, /\bsummary\b/, /\bstatistic/,
    /\bdatabase\b/, /\bdb\b/,
  ];

  if (dbPatterns.some(p => p.test(lower))) return "db";

  // ── Signals that are clearly general knowledge ──
  const generalPatterns = [
    /^what is\s+\w+\??$/, // "What is Python?" (short, no platform context)
    /^(explain|define|describe)\s+\w+/, // "Explain recursion"
    /^how does .+work/, // "How does JWT work?"
    /difference between/, // "Difference between X and Y"
    /^(what are (the )?benefits|advantages|disadvantages)/,
  ];

  if (generalPatterns.some(p => p.test(lower))) {
    // But override back to "db" if question mentions platform data
    const platformTerms = /student|college|batch|enrolled|score|course|result|skcet|srec/i;
    if (!platformTerms.test(lower)) return "general";
  }

  // Safe default: let the DB tools handle it
  return "db";
}

// ── System prompt for general knowledge questions ─────────────────────────────
const GENERAL_KNOWLEDGE_PROMPT = `You are a helpful assistant for Mako — an online coding education platform.
The user has asked a general knowledge or conceptual question (not a data query).
Answer clearly and thoroughly in Markdown format.
- Use ## heading to title your response
- Provide a clear explanation with examples where relevant
- For programming topics, include a short code example in a fenced code block
- Add practical context for how it applies to software development
- End with 1-2 sentences on real-world relevance
Keep it educational and engaging. This is NOT a database question — do not try to query anything.`;



// ── System prompt for DB questions (injected before live schema) ──────────────
const DB_SYSTEM_PREAMBLE = `You are a Database Console Assistant for Mako — an online coding education platform powered by TiDB (MySQL compatible).

## DATABASE STRUCTURE (CRITICAL — READ BEFORE EVERY QUERY)
### Table Naming Pattern:
Test scores are stored in: {college_code}_{year}_{semester}_test_data
Examples: srec_2025_2_test_data, mcet_2026_1_test_data
### All College Test Data Tables:
| College | Tables |
|---------|--------|
| SREC    | srec_2025_2_test_data, srec_2026_1_test_data |
| MCET    | mcet_2025_2_test_data, mcet_2026_1_test_data |
| SKCET   | skcet_2026_1_test_data |
| SKCT    | skct_2025_2_test_data |
| KITS    | kits_2026_1_test_data |
| NIET    | niet_2026_1_test_data |
| KCLAS   | kclas_2026_1_test_data |
| CIET    | ciet_2026_1_test_data |
### Columns in test_data tables:
id, user_id, allocate_id, course_allocation_id, topic_test_id, 
module_id, mark (JSON), total_mark (JSON), time, status, created_at
### JSON Score Extraction (MUST USE):
- Coding score: JSON_EXTRACT(mark, '$.co')
- Coding total: JSON_EXTRACT(total_mark, '$.co')
- MCQ score: JSON_EXTRACT(mark, '$.mcq')
- MCQ total: JSON_EXTRACT(total_mark, '$.mcq')
- Project score: JSON_EXTRACT(mark, '$.pro')
- Project total: JSON_EXTRACT(total_mark, '$.pro')
### Common Tables:
- users (id, name, email, roll_no, role, status)
- colleges (id, college_name, college_short_name)
- user_academics (user_id, college_id, batch_id, department_id, section_id)
- courses, topics, batches, sections, departments
### RULES:
1. Always filter: WHERE status = 1
2. Combine ALL semester tables with UNION ALL for a college
3. JOIN users ON user_id = users.id for student names
4. Calculate percentage: ROUND(SUM(mark)/NULLIF(SUM(total),0)*100, 2)
5. Use NULLIF to avoid division by zero
6. For college comparison: UNION ALL all college tables with college name label
### EXAMPLE — Compare All Colleges:
WITH all_tests AS (
    SELECT 'SREC' AS college, user_id,
           JSON_EXTRACT(mark, '$.co') AS co_mark, 
           JSON_EXTRACT(total_mark, '$.co') AS co_total,
           JSON_EXTRACT(mark, '$.mcq') AS mcq_mark, 
           JSON_EXTRACT(total_mark, '$.mcq') AS mcq_total
    FROM srec_2025_2_test_data WHERE status = 1
    UNION ALL
    SELECT 'SREC', user_id,
           JSON_EXTRACT(mark, '$.co'), JSON_EXTRACT(total_mark, '$.co'),
           JSON_EXTRACT(mark, '$.mcq'), JSON_EXTRACT(total_mark, '$.mcq')
    FROM srec_2026_1_test_data WHERE status = 1
    UNION ALL
    SELECT 'MCET', user_id,
           JSON_EXTRACT(mark, '$.co'), JSON_EXTRACT(total_mark, '$.co'),
           JSON_EXTRACT(mark, '$.mcq'), JSON_EXTRACT(total_mark, '$.mcq')
    FROM mcet_2025_2_test_data WHERE status = 1
    -- ... repeat for all colleges
)
SELECT college,
       COUNT(DISTINCT user_id) AS students,
       ROUND(SUM(co_mark)/NULLIF(SUM(co_total),0)*100, 2) AS coding_pct,
       ROUND(SUM(CASE WHEN mcq_total>0 THEN mcq_mark ELSE 0 END)/
             NULLIF(SUM(CASE WHEN mcq_total>0 THEN mcq_total ELSE 0 END),0)*100, 2) AS mcq_pct
FROM all_tests
GROUP BY college
ORDER BY coding_pct DESC;
### EXAMPLE — Top 5 Students in a College:
WITH tests AS (
    SELECT user_id,
           JSON_EXTRACT(mark, '$.co') AS co_mark, 
           JSON_EXTRACT(total_mark, '$.co') AS co_total
    FROM {college}_2025_2_test_data WHERE status = 1
    UNION ALL
    SELECT user_id,
           JSON_EXTRACT(mark, '$.co'), JSON_EXTRACT(total_mark, '$.co')
    FROM {college}_2026_1_test_data WHERE status = 1
)
SELECT u.name, ROUND(SUM(co_mark)/NULLIF(SUM(co_total),0)*100, 2) AS score
FROM tests t JOIN users u ON t.user_id = u.id
GROUP BY t.user_id, u.name
ORDER BY score DESC LIMIT 5;

## 🔑 THE 5 RULES YOU MUST FOLLOW EVERY TIME (CRITICAL)
Rule 1: READ before WRITE
- You MUST NOT GUESS. Never write SQL without first looking at the database.

Rule 2: Start broad, then narrow
- Step 1: Call \`list_tables\` to see everything available.
- Step 2: Call \`describe_table\` to see column types and ACTUAL data samples.
- Step 3: Call \`get_course_allocations\` if you need college prefixes.
- Step 4: NOW write the real query with full knowledge. I go wide first, then zoom in.

Rule 3: When data is JSON — ALWAYS inspect sample first
- You cannot guess JSON keys. You MUST use \`describe_table\` which returns sample rows showing EXACTLY how the \`mark\` and \`total_mark\` JSON is structured (e.g. '$.co').

Rule 4: Test before delivering
- Execute your SQL using \`run_sql\`. Check the results. If my query returns wrong results or errors, I fix it and retry. Do not return untested SQL.

Rule 5: Think about what could go wrong
- Question your own results. If a college has 0% coding but 88% overall, maybe they only took MCQ tests! Run extra queries to verify edge cases before giving your final answer.

## 🔄 RETRY PROTOCOL (CRITICAL)
- If \`run_sql\` returns an error, DO NOT GIVE UP. Read the error message carefully.
- Fix your SQL based on the error (wrong table name? missing JOIN? bad JSON key?).
- Retry up to 3 times with corrected SQL.
- Only after 3 failed attempts should you report failure to the user.
- Common fixes: check table name spelling, verify column exists via \`describe_table\`, check JSON key path.

## Role Values in \`users.role\`:
7=Student, 4=Staff, 5=Trainer, 6=ContentCreator, 3=CollegeAdmin, 2=Admin, 1=SuperAdmin

## Key Relationships:
- Students linked to college via course_wise_segregations (NOT directly in users).

` + getSmartRegistryContext();

// ── Report generation system prompt ───────────────────────────────────────────
const REPORT_SYSTEM_PROMPT = `You are a data analyst. Generate a brief report from SQL results.
## FORMAT RULES (STRICT):
1. START with a direct one-line answer to the question
   ✅ "There are 4,021 active students on the platform."
   ❌ "This analysis explores the active student population..."
2. Show data as a CLEAN markdown table
   - No extra columns
   - Round percentages to 2 decimal places
   - Use | alignment
3. Add 3-4 KEY INSIGHTS only (short bullet points)
   ✅ "SREC has the most tests (7,582) but lowest coding score (63.92%)"
   ❌ "The data shows that having academic information is more common (3,728) than being course-enrolled (3,132), suggesting students often complete their profiles before or without enrolling."
4. DO NOT include:
   ❌ "Context" paragraph
   ❌ "About Data Segmentation" or any educational paragraphs
   ❌ "Recommendations" (unless user specifically asks)
   ❌ Emojis on every bullet point
   ❌ Generic business advice
   ❌ Sentences longer than 20 words
   ❌ "Here are the results for your question! The query is ready in the console." (Just answer directly)
5. ANSWER ONLY WHAT WAS ASKED
   - If user asks for count, give count + table + 3 insights. Do not add extra fluff.
6. KEEP IT SHORT
   - Maximum 150 words
   - If the answer is a single number, say it in ONE line
   - Users want ANSWERS, not essays
## EXAMPLE — Good Report:
Question: "How many students are there?"
Data: [{total: 4021}, {enrolled: 3132}, {with_academics: 3728}]
Report:
There are **4,021 active students** on the Mako platform.
| Metric | Count |
|--------|-------|
| Total Active Students | 4,021 |
| Enrolled in Courses | 3,132 (78%) |
| With Academic Profile | 3,728 (93%) |
**Key Insights:**
- 93% of students have completed their academic profile
- 889 students (22%) are registered but not enrolled in any course
- 293 students are missing academic information
## EXAMPLE — Ranking Report:
Question: "Top 5 SREC students?"
Report:
The top performing SREC student is **AKSHAYA PRIYA S** with 95.13% overall.
| Rank | Student | Coding | MCQ | Overall |
|------|---------|--------|-----|---------|
| 1 | AKSHAYA PRIYA S | 95.51% | 84.00% | 95.13% |
| 2 | Joshika S | 91.28% | 93.94% | 91.35% |
| 3 | MANICKAVEL ARASI S | 91.53% | 84.00% | 91.34% |
| 4 | Priyadharshini R | 91.00% | 96.97% | 91.12% |
| 5 | ARAVINDHAN T | 91.90% | 64.00% | 91.07% |
**Key Insights:**
- AKSHAYA PRIYA S dominates with 95.51% coding score
- Priyadharshini R has the highest MCQ (96.97%) but coding brings her to #4
- ARAVINDHAN T has strong coding (91.90%) but weakest MCQ (64%)
## EXAMPLE — Student Profile Report:
Question: "Tell about SUTHIL T"
Report:
**SUTHIL T** (727824TUIO052) is a SKCT student ranked **#2 out of 883** with a perfect 100% project score.
| Field | Detail |
|-------|--------|
| College | Sri Krishna College of Technology (SKCT) |
| Department | BE CSE - Internet of Things |
| Batch | 2024-2028 |
| Tests Taken | 1 (Project-based) |
| Project Score | 30/30 = 100% ⭐ |
| College Rank | #2 out of 883 (Top 0.2%) |
| College Average | 11.97% |
**Key Insights:**
- Perfect score on his only project test
- 8.35x above college average
- SKCT only has project assessments — no coding/MCQ tests yet
NOW generate a report following these rules. Be CONCISE.`;

// ── SQL Validation Helper ───────────────────────────────────────────────────────
function validateSQL(sql: string): string[] {
  const issues: string[] = [];
  const upper = sql.toUpperCase();
  if (upper.includes("SELECT *")) issues.push("RULE VIOLATION: Don't use SELECT *. Select only specific needed columns.");
  if (!upper.includes("JOIN USERS") && !upper.includes("FROM USERS") && (upper.includes("TEST_DATA") || upper.includes("RESULT"))) {
    issues.push("RULE VIOLATION: Must JOIN users table to get real student names.");
  }
  if (!upper.includes("ORDER BY") && (upper.includes("BEST") || upper.includes("TOP") || upper.includes("PERFORM"))) {
    issues.push("RULE VIOLATION: Must ORDER BY for ranking queries.");
  }
  if (/ORDER BY\s+[a-zA-Z0-9_]*\.?id\b/i.test(sql) && (upper.includes("BEST") || upper.includes("TOP") || upper.includes("PERFORM") || upper.includes("RANK"))) {
    issues.push("RULE VIOLATION: Cannot rank by user ID — must rank by calculated score!");
  }
  if (upper.includes("COURSE_WISE_SEGREGATIONS") && (upper.includes("PERFORMER") || upper.includes("RANK") || upper.includes("SCORE"))) {
    issues.push("RULE VIOLATION: Use actual {college}_{batch}_test_data tables for calculating rankings or scores, not course_wise_segregations.");
  }
  return issues;
}

// ── POST /chat ─────────────────────────────────────────────────────────────────
agentRoutes.post("/chat", async (c) => {
  let body: Record<string, any> = {};
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const {
    question, user_id, user_role, consoleId, openConsoles,
  } = body as {
    question?: string; user_id?: string | number; user_role?: string | number;
    consoleId?: string; openConsoles?: any[];
  };

  if (!question?.trim()) return c.json({ error: "'question' is required" }, 400);

  const userId = user_id ? String(user_id) : "anonymous";
  const workspaceId = "000000000000000000000001";
  const chatModel = makeDeepSeekModel("deepseek-chat");
  const reasonerModel = makeDeepSeekModel("deepseek-reasoner");
  const route = preRouteQuestion(question.trim());

  logger.info("Agent chat", { userId, route, question: question.slice(0, 80) });

  // ── GENERAL path — fast knowledge answer, no tools ────────────────────────
  if (route === "general") {
    try {
      const result = await generateText({
        model: reasonerModel,
        system: GENERAL_KNOWLEDGE_PROMPT,
        messages: [{ role: "user" as const, content: question.trim() }],
        temperature: 0.4,
      });
      return c.json({ report: result.text?.trim() || "I couldn't generate an answer.", sql: null, steps: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("General path error", { error: msg });
      return c.json({ error: msg }, 500);
    }
  }

  // ── DB path — manual tool loop (LLM decides which tools to call) ─────────
  try {
    // Stage 1: Question Understanding (Intent Parsing via generateText + JSON parse)
    const understandingResult = await generateText({
      model: makeDeepSeekModel("deepseek-chat"),
      system: `You are a JSON-only classifier. Output ONLY a valid JSON object, no markdown, no explanation.`,
      messages: [{
        role: "user" as const, content: `Analyze this user question about an educational database:
"${question.trim()}"

Return a JSON object with these fields:
- "type": one of "ranking", "student_profile", "college_profile", "comparison", "count", "aggregation", "other"
- "college": specific college code (e.g. "srec", "mcet", "skcet") or "ALL" if comparing all
- "student": student name or roll number if mentioned, or null
- "needs_scores": true/false whether test_data or score computation is needed
- "limit": number if the question asks for top N, or null

JSON only:` }],
      temperature: 0,
    });

    let questionContext: { type: string; college: string; student?: string; needs_scores: boolean; limit?: number } = {
      type: "other", college: "ALL", needs_scores: true
    };
    try {
      const raw = (understandingResult.text || "").replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
      questionContext = JSON.parse(raw);
    } catch (_parseErr) {
      logger.warn("Failed to parse question context, using defaults", { text: understandingResult.text?.slice(0, 200) });
    }
    logger.info("Question Context Analyzed:", questionContext);

    const liveSchema = await getFullSchemaPrompt();

    let runtimeContext = `\n\nUser context: user_id = ${user_id ?? "unknown"}, user_role = ${user_role ?? "unknown"} (7 = Student, 4 = Staff, 5 = Trainer, 2 = Admin)`;
    if (consoleId) runtimeContext += `\nActive console ID: ${consoleId} `;

    // Inject the parsed context into the AI's preamble so it knows EXACTLY what it's building
    runtimeContext += `\n\nQUESTION INTENT ANALYSIS (from pre-parser):\n` + JSON.stringify(questionContext, null, 2);

    // Phase 3, Step 4: Multi-Query Routing
    let strategy = "";
    switch (questionContext.type) {
      case "count":
        strategy = `STRATEGY: You MUST use a single, simple, combined SQL query! 
        DO NOT use UNION ALL for count aggregations. DO NOT write 18 subqueries. DO NOT query every single table.
        Example: SELECT (SELECT COUNT(*) FROM users WHERE role = 7 AND status = 1) AS total,
                 (SELECT COUNT(DISTINCT user_id) FROM course_wise_segregations WHERE user_role = 7 AND status = 1) AS enrolled;`;
        break;
      case "ranking":
        strategy = "STRATEGY: You only need to run one big query using UNION ALL across all necessary college tables.";
        break;
      case "student_profile":
        strategy = "STRATEGY: You MUST run multiple separate SQL queries to build a complete profile! \nQuery 1: Get student info from users AND user_academics \nQuery 2: Get test scores from {college}_test_data \nQuery 3: Calculate rank among college peers \nQuery 4: Get college average for comparison.";
        break;
      case "comparison":
        strategy = "STRATEGY: Use a UNION ALL approach to compare colleges in a single query.";
        break;
      case "college_profile":
        strategy = "STRATEGY: You MUST run multiple separate SQL queries to build a complete profile! \nQuery 1: Get college info and student count \nQuery 2: Get overall performance stats \nQuery 3: Get their top 5 students.";
        break;
    }
    if (strategy) {
      runtimeContext += `\n\nMULTI-QUERY ROUTING STRATEGY:\n${strategy}`;
    }

    const systemPrompt = DB_SYSTEM_PREAMBLE + liveSchema + runtimeContext + findMatchingTemplate(question);

    // Inline server-side tools — guaranteed execute functions (no client-side tools)
    // This prevents the "Tool result is missing" error caused by client tools having no execute.
    const dbName = process.env.DB_NAME || "coderv4";
    const dbMock = { _id: "000000000000000000000002", type: "mysql" } as any;

    const tools = {
      list_tables: tool({
        description: "List all tables in the database. Call this first if you aren't sure of table names.",
        parameters: emptySchema,
        execute: async () => {
          console.log(`\n\n[AI TOOL / chat]list_tables() \n`);
          const res = await databaseConnectionService.executeQuery(dbMock, "SHOW TABLES", { databaseName: dbName });
          if (!res.success) return { error: res.error };
          return { tables: (res.data || []).map((r: any) => Object.values(r)[0]) };
        },
      } as any),
      describe_table: tool({
        description: "Get the columns, data types, and a sample row of a specific table. Call before using any table you haven't seen.",
        parameters: z.object({ table_name: z.string().optional().describe("Exact table name"), table: z.string().optional() }),
        execute: async (args: { table_name?: string; table?: string }) => {
          const tableName = args.table_name || args.table;
          console.log(`\n\n[AI TOOL / chat]describe_table(${tableName}) \n`);
          if (!tableName) return { error: "table_name is required" };
          const safe = tableName.replace(/[^a-zA-Z0-9_]/g, "");
          const descRes = await databaseConnectionService.executeQuery(dbMock, `DESCRIBE \`${safe}\``, { databaseName: dbName });
          if (!descRes.success) return { error: descRes.error };
          const sampleRes = await databaseConnectionService.executeQuery(dbMock, `SELECT * FROM \`${safe}\` LIMIT 3`, { databaseName: dbName });
          return {
            columns: descRes.data,
            sample_data: sampleRes.success && sampleRes.data ? sampleRes.data : []
          };
        },
      } as any),
      get_course_allocations: tool({
        description: "Find which college database prefixes (e.g. srec_2025_2) contain data for a specific course ID. ALWAYS use this before querying {college}_{batch}_coding_result or {college}_{batch}_mcq_result tables.",
        parameters: z.object({ course_id: z.number().describe("The ID of the course") }),
        execute: async ({ course_id }: { course_id: number }) => {
          console.log(`\n\n[AI TOOL /chat] get_course_allocations(${course_id})\n`);
          const query = `
            SELECT 
              cam.id as allocation_id, 
              cam.course_id, 
              cam.batch_id as batch,
              c.college_short_name as college,
              CONCAT(LOWER(REPLACE(c.college_short_name, ' ', '')), '_', cam.batch_id) as db_prefix
            FROM course_academic_maps cam
            JOIN colleges c ON c.id = cam.college_id
            WHERE cam.course_id = ${Number(course_id)}
          `;
          const res = await databaseConnectionService.executeQuery(dbMock, query, { databaseName: dbName });
          return res.success ? { allocations: res.data } : { error: res.error };
        },
      } as any),
      run_sql: tool({
        description: "Execute a SQL SELECT query and return rows. Only SELECT allowed.",
        parameters: z.object({ sql: z.string().optional().describe("SQL SELECT statement"), query: z.string().optional() }),
        execute: async (args: { sql?: string; query?: string }) => {
          const sql = args.sql || args.query || "";
          console.log(`\n\n[AI TOOL /chat] run_sql: ${sql.slice(0, 100)}...\n`);
          const cleaned = sql.trim().replace(/^```(sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
          if (!cleaned.toLowerCase().startsWith("select")) return { error: "Only SELECT queries are allowed." };

          const issues = validateSQL(cleaned);
          if (issues.length > 0) return { error: "SQL Rejected. Fix these issues: " + issues.join("; ") };

          const res = await databaseConnectionService.executeQuery(dbMock, cleaned, { databaseName: dbName });
          if (!res.success) return { error: res.error, sql: cleaned };

          const data = res.data || [];
          if (data.length === 0) {
            return { error: "No rows returned. Please verify your table name, schema, or JOIN conditions.", sql: cleaned };
          }

          // Phase 3, Step 2: Verify Results based on intent
          if (questionContext.type === "ranking") {
            const columns = Object.keys(data[0] || {}).map(c => c.toLowerCase());
            const hasScores = columns.some(c => c.includes('score') || c.includes('pct') || c.includes('mark') || c.includes('percent') || c.includes('total'));
            if (!hasScores) {
              return { error: "Validation Failed: Question asks for ranking, but the results lack score/percentage columns. You MUST calculate and SELECT scores. Fix your SQL and retry." };
            }
          }

          if (questionContext.limit && data.length > (questionContext.limit * 2) && data.length > 5) {
            return { error: `Validation Failed: You returned ${data.length} rows, but the question only asked for around ${questionContext.limit}. Use LIMIT or fix your groupings. Fix your SQL and retry.` };
          }

          if (questionContext.type === "student_profile") {
            const columns = Object.keys(data[0] || {}).map(c => c.toLowerCase());
            if (!columns.some(c => c.includes('name'))) {
              return { error: "Validation Failed: This is a student profile question but there is no 'name' column in the results. Did you JOIN users? Fix your SQL and retry." };
            }
          }

          // Guardrail: Check for unreasonable scores (> 100%)
          const firstRow = data[0] || {};
          const scoreWarnings: string[] = [];
          for (const [key, val] of Object.entries(firstRow)) {
            const lk = key.toLowerCase();
            if ((lk.includes('pct') || lk.includes('percent') || lk.includes('percentage')) && typeof val === 'number' && val > 110) {
              scoreWarnings.push(`${key}=${val} exceeds 100% — likely a calculation error`);
            }
          }
          if (scoreWarnings.length > 0) {
            return { error: `Validation Warning: ${scoreWarnings.join('; ')}. Check your SUM/divisor logic. Fix your SQL and retry.` };
          }

          return { rows: data.slice(0, 200), total: data.length, sql: cleaned };
        },
      } as any),
    };

    // SDK v6: use stopWhen instead of manual tool loop — SDK handles message format internally
    const result = await generateText({
      model: chatModel,
      system: systemPrompt,
      messages: [{ role: "user" as const, content: question.trim() }],
      tools: tools as any,
      stopWhen: stepCountIs(8),
      temperature: 0,
      onStepFinish: (step) => {
        const trace = `\n[AI STEP] completed. Tool calls: ${JSON.stringify(step.toolCalls)}\nResults: ${JSON.stringify(step.toolResults)}\n`;
        appendFileSync('ai_trace.log', trace);
        logger.info(trace);
      }
    });

    // Extract SQL and results from the SDK's internal steps
    let executedSql = "";
    const sqlResultsList: any[] = []; // Phase 3: Accumulate multiple datasets
    const stepsCount = result.steps?.length ?? 1;

    for (const step of result.steps ?? []) {
      for (const tr of (step.toolResults ?? []) as any[]) {
        const raw = tr.result ?? tr.output;
        if (tr.toolName === "run_sql" && raw?.rows?.length > 0) {
          sqlResultsList.push({ sql: raw.sql, data: raw.rows.slice(0, 100) });
          executedSql += raw.sql + ";\n";
        }
      }
    }

    // If LLM answered from knowledge (no data returned), return its text directly
    if (sqlResultsList.length === 0 && result.text?.trim()) {
      return c.json({ report: result.text.trim(), sql: executedSql || null, steps: stepsCount });
    }

    // ── Report generation pass (strictly bound to results) ───────────────────────
    let allDataJson = "";
    let totalRows = 0;
    sqlResultsList.forEach((res, i) => {
      totalRows += res.data.length;
      allDataJson += `\n\n--- Query ${i + 1} Results ---\nSQL: ${res.sql}\nDATA:\n${JSON.stringify(res.data, null, 2)}`;
    });

    const reportUserPrompt = `Question: "${question}"
You ran ${sqlResultsList.length} queries returning a total of ${totalRows} rows.
Here is the ACTUAL DATA you generated:
${allDataJson.slice(0, 12000)}${allDataJson.length > 12000 ? "\n...(truncated to fit)" : ""}`;

    const reportResult = await generateText({
      model: reasonerModel,
      system: REPORT_SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: reportUserPrompt }],
      temperature: 0,
    });

    const finalReport = reportResult.text?.trim() || `## Results\n\n${allDataJson}`;
    const totalSteps = stepsCount + 1;

    logger.info("Agent chat complete", { userId, steps: totalSteps, sqlRows: totalRows });
    return c.json({ report: finalReport, sql: executedSql || null, steps: totalSteps });


  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("DB path error", { error: msg });
    return c.json({ error: msg }, 500);
  }
});

// ── POST /chat-v2 — now with full parity: question understanding, strategy, verification ──
agentRoutes.post("/chat-v2", async (c) => {
  let body: Record<string, any> = {};
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const { question, user_id, user_role } = body as {
    question?: string; user_id?: string | number; user_role?: string | number;
  };

  if (!question?.trim()) return c.json({ error: "'question' is required" }, 400);

  const userId = user_id ? String(user_id) : "anonymous";
  const workspaceId = "000000000000000000000001";
  const dbName = process.env.DB_NAME || "coderv4";
  const dbMock = { _id: "000000000000000000000002", type: "mysql" } as any;
  const chatModel = makeDeepSeekModel("deepseek-chat");
  const reasonerModel = makeDeepSeekModel("deepseek-reasoner");
  const route = preRouteQuestion(question.trim());

  logger.info("Agent chat-v2", { userId, route, question: question.slice(0, 80) });

  // ── GENERAL path — fast knowledge answer, no tools ────────────────────────
  if (route === "general") {
    try {
      const result = await generateText({
        model: reasonerModel,
        system: GENERAL_KNOWLEDGE_PROMPT,
        messages: [{ role: "user" as const, content: question.trim() }],
        temperature: 0.4,
      });
      return c.json({ report: result.text?.trim() || "I couldn't generate an answer.", sql: null, steps: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("General path error (v2)", { error: msg });
      return c.json({ error: msg }, 500);
    }
  }

  // ── DB path ─────────────────────────────────────────────────────────────────
  try {
    // Stage 1: Question Understanding (same as /chat)
    const understandingResult = await generateText({
      model: makeDeepSeekModel("deepseek-chat"),
      system: `You are a JSON-only classifier. Output ONLY a valid JSON object, no markdown, no explanation.`,
      messages: [{
        role: "user" as const, content: `Analyze this user question about an educational database:
"${question.trim()}"

Return a JSON object with these fields:
- "type": one of "ranking", "student_profile", "college_profile", "comparison", "count", "aggregation", "other"
- "college": specific college code (e.g. "srec", "mcet", "skcet") or "ALL" if comparing all
- "student": student name or roll number if mentioned, or null
- "needs_scores": true/false whether test_data or score computation is needed
- "limit": number if the question asks for top N, or null

JSON only:` }],
      temperature: 0,
    });

    let questionContext: { type: string; college: string; student?: string; needs_scores: boolean; limit?: number } = {
      type: "other", college: "ALL", needs_scores: true
    };
    try {
      const raw = (understandingResult.text || "").replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
      questionContext = JSON.parse(raw);
    } catch (parseErr) {
      logger.warn("Failed to parse question context (v2), using defaults", { text: understandingResult.text?.slice(0, 200) });
    }
    logger.info("Question Context Analyzed (v2):", questionContext);

    const liveSchema = await getFullSchemaPrompt();

    let runtimeContext = `\n\nUser context: user_id = ${user_id ?? "unknown"}, user_role = ${user_role ?? "unknown"} (7 = Student, 4 = Staff, 5 = Trainer, 2 = Admin)`;
    runtimeContext += `\n\nQUESTION INTENT ANALYSIS (from pre-parser):\n` + JSON.stringify(questionContext, null, 2);

    // Multi-Query Routing
    let strategy = "";
    switch (questionContext.type) {
      case "count":
        strategy = `STRATEGY: You MUST use a single, simple, combined SQL query! 
        DO NOT use UNION ALL for count aggregations. DO NOT write 18 subqueries. DO NOT query every single table.
        Example: SELECT (SELECT COUNT(*) FROM users WHERE role = 7 AND status = 1) AS total,
                 (SELECT COUNT(DISTINCT user_id) FROM course_wise_segregations WHERE user_role = 7 AND status = 1) AS enrolled;`;
        break;
      case "ranking":
        strategy = "STRATEGY: You only need to run one big query using UNION ALL across all necessary college tables.";
        break;
      case "student_profile":
        strategy = "STRATEGY: You MUST run multiple separate SQL queries to build a complete profile! \nQuery 1: Get student info from users AND user_academics \nQuery 2: Get test scores from {college}_test_data \nQuery 3: Calculate rank among college peers \nQuery 4: Get college average for comparison.";
        break;
      case "comparison":
        strategy = "STRATEGY: Use a UNION ALL approach to compare colleges in a single query.";
        break;
      case "college_profile":
        strategy = "STRATEGY: You MUST run multiple separate SQL queries to build a complete profile! \nQuery 1: Get college info and student count \nQuery 2: Get overall performance stats \nQuery 3: Get their top 5 students.";
        break;
    }
    if (strategy) {
      runtimeContext += `\n\nMULTI-QUERY ROUTING STRATEGY:\n${strategy}`;
    }

    const systemPrompt = DB_SYSTEM_PREAMBLE + liveSchema + runtimeContext + findMatchingTemplate(question);

    const tools = {
      list_tables: tool({
        description: "List all tables in the database.",
        parameters: emptySchema,
        execute: async () => {
          console.log(`\n\n[AI TOOL /chat-v2] list_tables()\n`);
          const res = await databaseConnectionService.executeQuery(dbMock, "SHOW TABLES", { databaseName: dbName });
          return res.success ? { tables: res.data?.map((r: any) => Object.values(r)[0]) || [] } : { error: res.error };
        },
      } as any),
      describe_table: tool({
        description: "Get the columns, data types, and a sample row of a specific table. Call before using any table you haven't seen.",
        parameters: z.object({ table_name: z.string().optional(), table: z.string().optional() }),
        execute: async (args: { table_name?: string; table?: string }) => {
          const tableName = args.table_name || args.table;
          console.log(`\n\n[AI TOOL /chat-v2] describe_table(${tableName})\n`);
          if (!tableName) return { error: "table_name is required" };
          const safe = tableName.replace(/[^a-zA-Z0-9_]/g, "");
          const descRes = await databaseConnectionService.executeQuery(dbMock, `DESCRIBE \`${safe}\``, { databaseName: dbName });
          if (!descRes.success) return { error: descRes.error };
          const sampleRes = await databaseConnectionService.executeQuery(dbMock, `SELECT * FROM \`${safe}\` LIMIT 3`, { databaseName: dbName });
          return {
            columns: descRes.data,
            sample_data: sampleRes.success && sampleRes.data ? sampleRes.data : []
          };
        },
      } as any),
      get_course_allocations: tool({
        description: "Find which college database prefixes (e.g. srec_2025_2) contain data for a specific course ID.",
        parameters: z.object({ course_id: z.number() }),
        execute: async ({ course_id }: { course_id: number }) => {
          console.log(`\n\n[AI TOOL /chat-v2] get_course_allocations(${course_id})\n`);
          const query = `
            SELECT 
              cam.id as allocation_id, 
              cam.course_id, 
              cam.batch_id as batch,
              c.college_short_name as college,
              CONCAT(LOWER(REPLACE(c.college_short_name, ' ', '')), '_', cam.batch_id) as db_prefix
            FROM course_academic_maps cam
            JOIN colleges c ON c.id = cam.college_id
            WHERE cam.course_id = ${Number(course_id)}
          `;
          const res = await databaseConnectionService.executeQuery(dbMock, query, { databaseName: dbName });
          return res.success ? { allocations: res.data } : { error: res.error };
        },
      } as any),
      run_sql: tool({
        description: "Execute a SQL SELECT query and return rows. Only SELECT allowed.",
        parameters: z.object({ sql: z.string().optional(), query: z.string().optional() }),
        execute: async (args: { sql?: string; query?: string }) => {
          const sql = args.sql || args.query || "";
          console.log(`\n\n[AI TOOL /chat-v2] run_sql: ${sql.slice(0, 100)}...\n`);
          const cleaned = sql.trim().replace(/^```(sql)?\s*/i, "").replace(/\s*```$/i, "").trim();
          if (!cleaned.toLowerCase().startsWith("select")) return { error: "Only SELECT queries allowed" };

          const issues = validateSQL(cleaned);
          if (issues.length > 0) return { error: "SQL Rejected. Fix these issues: " + issues.join("; ") };

          const res = await databaseConnectionService.executeQuery(dbMock, cleaned, { databaseName: dbName });
          if (!res.success) return { error: res.error, sql: cleaned };

          const data = res.data || [];
          if (data.length === 0) {
            return { error: "No rows returned. Please verify your table name, schema, or JOIN conditions.", sql: cleaned };
          }

          // Full verification (parity with /chat)
          if (questionContext.type === "ranking") {
            const columns = Object.keys(data[0] || {}).map(c => c.toLowerCase());
            const hasScores = columns.some(c => c.includes('score') || c.includes('pct') || c.includes('mark') || c.includes('percent') || c.includes('total'));
            if (!hasScores) {
              return { error: "Validation Failed: Question asks for ranking, but the results lack score/percentage columns. You MUST calculate and SELECT scores. Fix your SQL and retry." };
            }
          }

          if (questionContext.limit && data.length > (questionContext.limit * 2) && data.length > 5) {
            return { error: `Validation Failed: You returned ${data.length} rows, but the question only asked for around ${questionContext.limit}. Use LIMIT or fix your groupings. Fix your SQL and retry.` };
          }

          if (questionContext.type === "student_profile") {
            const columns = Object.keys(data[0] || {}).map(c => c.toLowerCase());
            if (!columns.some(c => c.includes('name'))) {
              return { error: "Validation Failed: This is a student profile question but there is no 'name' column in the results. Did you JOIN users? Fix your SQL and retry." };
            }
          }

          // Score range guardrail
          const firstRow = data[0] || {};
          const scoreWarnings: string[] = [];
          for (const [key, val] of Object.entries(firstRow)) {
            const lk = key.toLowerCase();
            if ((lk.includes('pct') || lk.includes('percent') || lk.includes('percentage')) && typeof val === 'number' && val > 110) {
              scoreWarnings.push(`${key}=${val} exceeds 100% — likely a calculation error`);
            }
          }
          if (scoreWarnings.length > 0) {
            return { error: `Validation Warning: ${scoreWarnings.join('; ')}. Check your SUM/divisor logic. Fix your SQL and retry.` };
          }

          return { rows: data.slice(0, 200), total: data.length, sql: cleaned };
        },
      } as any),
    };

    // SDK v6: stopWhen handles the full tool loop internally
    const result = await generateText({
      model: chatModel,
      system: systemPrompt,
      messages: [{ role: "user" as const, content: question.trim() }],
      tools,
      stopWhen: stepCountIs(8),
      temperature: 0,
      onStepFinish: (step) => {
        const trace = `\n[AI STEP v2] completed. Tool calls: ${JSON.stringify(step.toolCalls)}\nResults: ${JSON.stringify(step.toolResults)}\n`;
        require('fs').appendFileSync('ai_trace.log', trace);
        logger.info(trace);
      }
    });

    // Extract SQL and results (accumulate multiple datasets like /chat)
    let executedSql = "";
    let sqlResultsList: any[] = [];
    const stepsCount = result.steps?.length ?? 1;

    for (const step of result.steps ?? []) {
      for (const tr of (step.toolResults ?? []) as any[]) {
        const raw = tr.result ?? tr.output;
        if (tr.toolName === "run_sql" && raw?.rows?.length > 0) {
          sqlResultsList.push({ sql: raw.sql, data: raw.rows.slice(0, 100) });
          executedSql += raw.sql + ";\n";
        }
      }
    }

    if (sqlResultsList.length === 0 && result.text?.trim()) {
      return c.json({ report: result.text.trim(), sql: null, steps: stepsCount });
    }

    // Report generation (same as /chat)
    let allDataJson = "";
    let totalRows = 0;
    sqlResultsList.forEach((res, i) => {
      totalRows += res.data.length;
      allDataJson += `\n\n--- Query ${i + 1} Results ---\nSQL: ${res.sql}\nDATA:\n${JSON.stringify(res.data, null, 2)}`;
    });

    const reportUserPrompt = `Question: "${question}"
You ran ${sqlResultsList.length} queries returning a total of ${totalRows} rows.
Here is the ACTUAL DATA you generated:
${allDataJson.slice(0, 12000)}${allDataJson.length > 12000 ? "\n...(truncated to fit)" : ""}`;

    const reportResult = await generateText({
      model: reasonerModel,
      system: REPORT_SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: reportUserPrompt }],
      temperature: 0,
    });

    const finalReport = reportResult.text?.trim() || `## Results\n\n${allDataJson}`;
    const totalSteps = stepsCount + 1;

    logger.info("Agent chat-v2 complete", { userId, steps: totalSteps, sqlRows: totalRows });
    return c.json({ report: finalReport, sql: executedSql || null, steps: totalSteps });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Agent chat-v2 error", { error: msg });
    return c.json({ error: msg }, 500);
  }
});
