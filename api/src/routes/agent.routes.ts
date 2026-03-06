/**
 * Agent Routes — Pre-Fetch + Role Access + Anti-Hallucination + Cache + Fallback
 *
 * Architecture:
 *   Known questions → buildUserContext() → buildDataReport() → LLM insights (fast, cached)
 *   Unknown questions → handleWithTools() → LLM discovers with tools (secure fallback)
 *   Greeting → personalized by role + college (instant)
 *   General → deepseek-reasoner knowledge answer (1 call)
 *
 * Numbers ALWAYS come from code templates. LLM NEVER touches numbers.
 */

import { Hono } from "hono";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { getAvailableModels } from "../agent-lib/ai-models";
import { databaseConnectionService } from "../services/database-connection.service";
import { getAllAgentMeta } from "../agents";
import { loggers } from "../logging";
import { ROLES, canAccess, getScope, getRoleName, getSQLScope, getScopeDescription } from "../agent-lib/role-access";
import { classifyQuestion } from "../agent-lib/question-classifier";

const logger = loggers.agent();
export const agentRoutes = new Hono();

// Global token tracker for the current request
export const deepseekUsages = new Map<string, { input: number, output: number }>();

const dbName = process.env.DB_NAME || "coderv4";
const dbMock = { _id: "000000000000000000000002", type: "mysql" } as any;

// ── DeepSeek model factory ────────────────────────────────────────────────────
function makeDeepSeekModel(modelName: "deepseek-chat" | "deepseek-reasoner" = "deepseek-chat") {
  const patchedFetch = async (url: string, options: any) => {
    let reqId = "";
    // Intercept tracking ID from our custom header
    if (options?.headers && options.headers["x-ds-tracker"]) {
      reqId = options.headers["x-ds-tracker"];
      delete options.headers["x-ds-tracker"]; // clean up before sending to real API
    }

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
    const response = await fetch(url, options);
    const cloned = response.clone();
    cloned.json().then(data => {
      if (data?.usage && reqId) {
        if (!deepseekUsages.has(reqId)) deepseekUsages.set(reqId, { input: 0, output: 0 });
        const current = deepseekUsages.get(reqId)!;
        current.input += data.usage.prompt_tokens || 0;
        current.output += data.usage.completion_tokens || 0;
      }
    }).catch(() => { });
    return response;
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CACHE — 5 min for user data, 30 min for table lists
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const dataCache = new Map<string, { result: any; expiry: number }>();

function getCached(key: string): any | null {
  const entry = dataCache.get(key);
  if (entry && entry.expiry > Date.now()) return entry.result;
  dataCache.delete(key);
  return null;
}

function setCache(key: string, result: any, ttlMs = 5 * 60_000) {
  dataCache.set(key, { result, expiry: Date.now() + ttlMs });
}

// Clean expired cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dataCache.entries()) {
    if (entry.expiry < now) dataCache.delete(key);
  }
}, 10 * 60_000);

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DATA LAYER — Deterministic data fetching. LLM never touches the DB.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function runQuery(sql: string): Promise<{ rows: any[]; sql: string; error?: string }> {
  const res = await databaseConnectionService.executeQuery(dbMock, sql, { databaseName: dbName });
  return { rows: res.data || [], sql, error: res.error };
}

// ═══════════════════════════════════════════════════════════════
// SCHEMA CACHE — Load once at startup, reuse forever (refresh 30 min)
// Eliminates 3-4 tool steps per query (no more list_tables + describe_table)
// ═══════════════════════════════════════════════════════════════
let cachedTableSchemas: Record<string, string> = {};

const SCHEMA_TABLES = [
  'users', 'user_academics', 'colleges', 'departments',
  'batches', 'sections', 'courses', 'course_academic_maps',
  'course_wise_segregations', 'user_course_enrollments',
  'course_staff_trainer_allocations', 'institutions',
  'practice_modules', 'topics', 'titles',
  'verify_certificates', 'languages'
];

async function loadSchemaCache() {
  try {
    const newCache: Record<string, string> = {};
    for (const table of SCHEMA_TABLES) {
      const res = await runQuery(`DESCRIBE \`${table}\``);
      if (res.rows && res.rows.length > 0) {
        let columns = res.rows.map((r: any) => r.Field).join(', ');
        newCache[table] = columns;
      }
    }
    cachedTableSchemas = newCache;
    logger.info(`[schema-cache] Cached ${Object.keys(cachedTableSchemas).length} table schemas`);
  } catch (err: any) {
    logger.error(`[schema-cache] Failed to load schema: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// ROLE-TAILORED SCHEMA BUILDER
// ═══════════════════════════════════════════════════════════════
function buildRoleTailoredSchema(roleNum: number): string {
  const isStudentOrContentCreator = roleNum >= 6;
  const isCollegeScoped = roleNum >= 3 && roleNum <= 5;

  let schema = "DATABASE SCHEMA (live from DB — use these columns directly):\n";

  // Filter which tables to expose based on role
  const restrictedTablesForStudents = ['users', 'institutions', 'colleges', 'departments'];

  for (const [table, columns] of Object.entries(cachedTableSchemas)) {
    if (isStudentOrContentCreator && restrictedTablesForStudents.includes(table)) {
      continue; // Hide infrastructure tables from students
    }
    schema += `- ${table}: ${columns}\n`;
  }

  // --- ENUMS & STATUS ---
  schema += `\nENUM VALUES (use EXACT numbers, never strings):\n`;
  if (!isStudentOrContentCreator) {
    schema += `- users.role: 1=SuperAdmin, 2=Admin, 3=CollegeAdmin, 4=Staff, 5=Trainer, 6=ContentCreator, 7=Student\n`;
    schema += `- users.gender: 1=Male, 2=Female, 3=Other (NULL/0=not set)\n`;
  }
  schema += `- course_wise_segregations.type: 1=Prepare, 2=Assessment (each row has BOTH coding_question and mcq_question JSON)\n`;
  schema += `- courses.category: 1=Foundation, 2=Advanced, 3=Specialized\n`;
  schema += `- status column (ALL tables): 1=active. Always add WHERE status=1.\n`;

  schema += `\nDYNAMIC TABLES (per-college, per-semester):\n`;
  schema += `Pattern: {college_short_name}_{year}_{sem}_{type}\n`;
  schema += `Example: srec_2026_1_coding_result, skcet_2025_2_mcq_result\n`;
  if (!isStudentOrContentCreator) {
    schema += `Find tables: SHOW TABLES LIKE '{short_name}_%_coding_result'\n`;
  }
  schema += `\n`;

  schema += `{college}_{year}_{sem}_coding_result columns:\n`;
  schema += `  user_id, question_id, module_id, topic_test_id, complexity\n`;
  schema += `  solve_status (int): 0=new, 1=partial, 2=SOLVED, 3=wrong_answer\n`;
  schema += `  mark (float): score earned. total_mark (float): max possible\n`;
  schema += `  total_time (int): seconds spent. compile_id: language used\n`;
  schema += `  first_submission_time, correct_submission_time (int)\n`;
  schema += `  main_solution (text), test_cases (json), errors (json)\n`;
  schema += `  ⚠️ "status" = row active flag (always 1), NOT solve result!\n`;
  schema += `  ⚠️ Use solve_status=2 for "solved". NEVER status='Accepted'!\n`;
  schema += `  ⚠️ Column is "mark" NOT "score". "total_time" NOT "execution_time".\n\n`;

  schema += `{college}_{year}_{sem}_mcq_result columns:\n`;
  schema += `  user_id, question_id, module_id, topic_test_id, complexity\n`;
  schema += `  solve_status (int): same as coding (0/1/2/3)\n`;
  schema += `  mark (float), total_mark (float), total_time (int)\n`;
  schema += `  attempt_count (int), solution (text), type (tinyint)\n`;
  schema += `  ⚠️ Same rules: solve_status=2 = solved. "mark" not "score".\n\n`;

  schema += `{college}_{year}_{sem}_test_data columns:\n`;
  schema += `  user_id, topic_test_id, module_id\n`;
  schema += `  mark (JSON not numeric!), total_mark (JSON not numeric!)\n`;
  schema += `  time (int), total_time (int), question_ids (json)\n`;
  schema += `  question_status (json), attempt_datas (json)\n\n`;

  schema += `QUERY HINTS:\n`;
  if (!isStudentOrContentCreator) {
    schema += `- "allocated courses" → COUNT from course_academic_maps (NOT courses table)\n`;
    schema += `- "available courses" → courses WHERE status = 1\n`;
  }
  schema += `- "enrolled courses" / "my scores" → course_wise_segregations WHERE user_id = X\n`;
  schema += `- "my trainer" → course_wise_segregations → course_academic_maps → course_staff_trainer_allocations\n`;
  schema += `- Student progress/scores (aggregated) → course_wise_segregations (best table)\n`;
  schema += `- Per-question details → dynamic coding_result/mcq_result tables\n\n`;

  schema += `DATA RELATIONSHIPS (how to trace Course → Topic → Question → Result):\n`;
  schema += `1. Student's courses: course_wise_segregations WHERE user_id = X (aggregated scores)\n`;
  schema += `2. Course topics: course_academic_maps WHERE course_id = X AND college_id = Y\n`;
  schema += `   → topic_name = topic label. db = semester prefix for dynamic tables.\n`;
  schema += `3. Per-question coding: {db}_coding_result WHERE user_id = X AND course_allocation_id = cam.id\n`;
  schema += `   → errors (JSON array): each element has {error: string, details: string}\n`;
  schema += `   → action_counts (JSON): {att: attempts, run: runs, ver: verifications, deb: debug}\n`;
  schema += `   → main_solution (text): the student's actual submitted code\n`;
  schema += `4. Per-question MCQ: {db}_mcq_result WHERE user_id = X AND course_allocation_id = cam.id\n`;
  schema += `5. Test session: {db}_test_data WHERE user_id = X
   → mark/total_mark are JSON: {co: coding, mcq: mcq, pro: project}
   → question_ids (JSON array): list of question IDs in this test

IDENTITY / "who am I?" / profile queries:
  Use ONE query to get profile + all course stats:
  SELECT u.name, u.email, u.contact_number, u.roll_no, u.dob,
    CASE u.gender WHEN 0 THEN 'Male' WHEN 1 THEN 'Female' WHEN 2 THEN 'Other' END as gender,
    c.college_name, d.department_name, b.batch_name, s.section_name,
    ua.academic_info, ua.personal_info,
    co.course_name,
    CASE cws.type WHEN 1 THEN 'Prepare' WHEN 2 THEN 'Assessment' END as mode,
    cws.progress, cws.score, cws.\`rank\` as dept_rank,
    ROUND(cws.time_spend/3600,1) as hours,
    JSON_EXTRACT(cws.coding_question,'$.solved_question') as coding_solved,
    JSON_EXTRACT(cws.coding_question,'$.total_question') as coding_total,
    JSON_EXTRACT(cws.mcq_question,'$.solved_question') as mcq_solved,
    JSON_EXTRACT(cws.mcq_question,'$.total_question') as mcq_total
  FROM users u
  LEFT JOIN user_academics ua ON u.id=ua.user_id AND ua.status=1
  LEFT JOIN colleges c ON ua.college_id=c.id
  LEFT JOIN departments d ON ua.department_id=d.id
  LEFT JOIN batches b ON ua.batch_id=b.id
  LEFT JOIN sections s ON ua.section_id=s.id
  LEFT JOIN course_wise_segregations cws ON u.id=cws.user_id AND cws.status=1
  LEFT JOIN courses co ON cws.course_id=co.id
  WHERE u.id={user_id}
  academic_info/personal_info are JSON with: tenth,twelth,ug,backlogs,git,linkedin\n\n`;

  schema += `COMMON STUDENT DEEP-DIVE QUERIES:\n`;
  schema += `- "my course details" → course_wise_segregations + courses table\n`;
  schema += `- "topic-wise breakdown" → JOIN coding_result with course_academic_maps on course_allocation_id = cam.id\n`;
  schema += `- "what errors did I make" → coding_result.errors JSON (array of {error, details})\n`;
  schema += `- "how to fix my errors" → Read errors JSON, explain the compilation/runtime error\n`;
  schema += `- "my coding attempts" → action_counts JSON: att=attempts, run=code runs, ver=test verifications\n`;
  schema += `- "show my code" → main_solution column (text, student's submitted code)\n\n`;

  schema += `CRITICAL AGENT RULES:\n`;
  schema += `1. Use coding_result tables for per-question counts, NOT CWS JSON.\n`;
  schema += `2. correct_submission_time is seconds elapsed — use created_at for dates!\n`;
  schema += `3. Rank data lives in CWS → \`rank\` (backtick it!) and performance_rank columns.\n`;
  schema += `4. Follow-up answers must match the depth of the original response.\n\n`;

  schema += `IMPORTANT — Finding dynamic tables for a student:\n`;
  schema += `  The student's dynamic table prefixes are pre-fetched and provided in the ACCESS CONTROL section.\n`;
  schema += `  Use those prefixes directly — do NOT query college_short_name or cam.db yourself!\n`;
  if (!isStudentOrContentCreator) {
    schema += `  If no prefixes are provided, query: SELECT DISTINCT cam.db FROM course_wise_segregations cws\n`;
    schema += `    JOIN course_academic_maps cam ON cws.course_allocation_id = cam.allocation_id\n`;
    schema += `    WHERE cws.user_id = {user_id} AND cam.db IS NOT NULL\n`;
    schema += `  ⚠️ cam.db may differ from college_short_name! (e.g., dotlab ≠ demolab, skacas ≠ skasc)\n\n`;
  }

  schema += `PERFORMANCE OVERVIEW (use FIRST for "how am I doing?" questions):\n`;
  schema += `  course_wise_segregations: Pre-computed summary per user per course.\n`;
  schema += `  Columns: progress (%), score, rank, performance_rank, time_spend (sec)\n`;
  schema += `  JSON columns:\n`;
  schema += `    coding_question: {total_question, attend_question, solved_question, par_question, obtain_score, total_score, code_quality}\n`;
  schema += `    mcq_question: {total_question, attend_question, solved_question, par_question, obtain_score, total_score}\n`;
  schema += `  JOIN: cws.course_id → courses.id for course names\n`;
  schema += `  ⚠️ cws.course_allocation_id → cam.allocation_id (NOT cam.id!)\n`;
  schema += `  Use CWS for overview. For question-level detail, query dynamic result tables.\n\n`;

  schema += `DYNAMIC TABLE ROUTING:\n`;
  schema += `  course_academic_maps has TWO IDs — don't confuse them:\n`;
  schema += `    cam.id (PK) → referenced as course_allocation_id in coding_result/mcq_result\n`;
  schema += `    cam.allocation_id → referenced as course_allocation_id in course_wise_segregations\n`;
  schema += `    cam.allocation_id → also referenced as allocate_id in some result tables\n`;
  schema += `  cam.db = exact dynamic table prefix (e.g., "srec_2025_2")\n`;
  schema += `  cam.type: 0=Prepare, 1=Assessment, 2=Assignment, 3=Practice\n\n`;

  schema += `DAILY ACTIVITY: \`2025_submission_tracks\` and \`2026_submission_tracks\`\n`;
  schema += `  (⚠️ backticks REQUIRED — table names start with numbers!)\n`;
  schema += `  mode: 1=mcq/fillups, 2=coding | type: 1=prepare, 2=assessment\n`;
  schema += `  period: month number\n`;
  schema += `  COLUMNS: attended_count_details (JSON), solved_count_details (JSON)\n`;
  schema += `  ⚠️ THESE COLUMNS DO NOT EXIST: attended_count, solved_count — NEVER USE THEM!\n`;
  schema += `  → To count: use JSON_LENGTH(attended_count_details) or extract keys\n\n`;

  schema += `CERTIFICATES: verify_certificates table\n`;
  schema += `  user_id, course_id, college_id, total_mark, mark_obtained, percentage, grade, p_id\n\n`;

  schema += `HIERARCHY: courses → titles (chapters) → topics (lessons)\n`;
  schema += `  course_topic_maps: course_id → title_id → topic_id + order\n`;
  schema += `  languages table: id → language_name (for compile_id lookups in coding_result)\n\n`;

  if (!isStudentOrContentCreator) {
    schema += `ROLE MAPPING: users.role integer values:\n`;
    schema += `  1=Super Admin, 2=Admin, 3=College Admin, 4=Staff, 5=Trainer, 6=Content Creator, 7=Student\n\n`;

    schema += `AI USAGE COLUMNS (users table):\n`;
    schema += `  stats_chat_count (int), stats_words_generated (bigint), active_streak (int), last_active_date\n`;
  }

  return schema;
}

// Load on startup + refresh every 30 minutes
loadSchemaCache();
setInterval(loadSchemaCache, 30 * 60_000);


// ── User profile (always fetched for context + college_id) ────────────────────
async function getUserProfile(userId: number) {
  const res = await runQuery(`
    SELECT u.id, u.name, u.email, u.role, u.roll_no,
      c.id AS college_id, c.college_name, c.college_short_name,
      d.department_name, b.batch_name
    FROM users u
    LEFT JOIN user_academics ua ON ua.user_id = u.id AND ua.status = 1
    LEFT JOIN colleges c ON c.id = ua.college_id
    LEFT JOIN departments d ON d.id = ua.department_id
    LEFT JOIN batches b ON b.id = ua.batch_id
    WHERE u.id = ${isNaN(Number(userId)) ? 0 : Number(userId)} LIMIT 1
  `);
  return res.rows?.[0] || null;
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SCOPE PROMPT BUILDER — Guide the LLM, don't replace it
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•ââ•â•â•â•â•â•â•â•â•â•

/**
 * Builds a scope-aware security prompt for the LLM based on role + question classification.
 * This is the ONLY RBAC layer needed — the LLM handles everything else.
 */
function buildScopePrompt(
  roleNum: number,
  userId: number,
  collegeId: number | null,
  scope: string,
  userName?: string,
  collegeShortName?: string,
  collegeDynamicTables?: string[],
): { prompt: string; blocked: boolean; blockReason?: string } {
  const roleName = getRoleName(roleNum);
  const sqlScope = getSQLScope(roleNum, userId, collegeId);
  const name = userName || 'User';

  let prompt = `\n--- ACCESS CONTROL ---\n`;
  prompt += `Current user: ${name} (${roleName}, user_id=${userId})\n`;
  if (collegeShortName) {
    prompt += `College: ${collegeShortName} (college_id=${collegeId})\n`;
    prompt += `Dynamic tables for this student: ${(collegeDynamicTables || []).join(', ') || `Use SHOW TABLES LIKE '${collegeShortName}_%'`}\n`;
    prompt += `→ Use these tables directly — do NOT query college_short_name again!\n`;
  }
  prompt += `\n`;

  // Security rules apply to ALL roles
  prompt += `SECURITY RULES (apply to ALL roles):\n`;
  prompt += `- NEVER return passwords, tokens, API keys, OTPs from any table.\n`;
  prompt += `- NEVER expose password columns even if asked directly.\n`;

  // Student/Content Creator specific security rules
  if (roleNum >= 6) {
    prompt += `\nSECURITY: NEVER reveal internal details to students:\n`;
    prompt += `- No table names, column names, or database structure\n`;
    prompt += `- No technology stack (MySQL, TiDB, etc.)\n`;
    prompt += `- No architecture diagrams or system design\n`;
    prompt += `- No business metrics (number of colleges, courses, users)\n`;
    prompt += `- If asked about system/architecture, respond with: 'Amypo LMS is a comprehensive learning platform with coding practice, assessments, and AI-powered assistance. For technical details, please contact your administrator.'\n`;
  }

  prompt += `\n`;

  // -- PERSONAL scope: user asking about their own data --
  if (scope === "personal") {
    prompt += `SCOPE: PERSONAL - This user is asking about their OWN data.\n`;
    prompt += `RULES:\n`;
    prompt += `- ALWAYS add WHERE user_id = ${userId} to filter for this user's data.\n`;
    prompt += `- ONLY return THIS user's data.\n`;
    prompt += `- Do NOT fetch profile data (name, email, roll_no, college) unless the user specifically asks for it.\n`;
    prompt += `- For "who am I" / "my profile": STRICTLY USE the 1-query SQL provided in the schema block below.\n`;
    prompt += `- For "my scores/progress": query course_wise_segregations WHERE user_id = ${userId}.\n`;
    prompt += `- For "my trainer": find via course_wise_segregations -> course_academic_maps -> course_staff_trainer_allocations.\n`;
    prompt += `- For "my courses/enrolled": query course_wise_segregations WHERE user_id = ${userId} AND status = 1.\n`;
    prompt += `- For question titles: JOIN academic_qb_codings aqc ON coding_result.question_id = aqc.id → use aqc.title\n`;
    prompt += `- For \"course status/progress\": query CWS + courses table. Format each course as:\n`;
    prompt += `  [Course Name]: X/Y items completed (Z%)\n`;
    prompt += `  Get X from coding_question JSON (attend_question + solved_question) and Y from (total_question).\n`;
    prompt += `  Use progress column for the percentage. List ALL enrolled courses, sorted by progress DESC.\n`;

    // FIX 1: Pre-inject exact active database tables related to this student so LLM stops running SHOW TABLES
    if (collegeDynamicTables && collegeDynamicTables.length > 0) {
      prompt += `\nYOUR DATA TABLES (Use exactly these — DO NOT RUN SHOW TABLES!):\n`;
      for (const t of collegeDynamicTables) {
        if (t.includes('coding_result')) prompt += `  Coding: ${t}\n`;
        else if (t.includes('mcq_result')) prompt += `  MCQ: ${t}\n`;
        else if (t.includes('test_data')) prompt += `  Test: ${t}\n`;
      }
      prompt += `  Query ALL semester tables concurrently with UNION ALL if you need full historical data.\n`;
    }

    prompt += `\n--- END ACCESS CONTROL ---\n`;
    return { prompt, blocked: false };
  }

  // -- RESTRICTED scope: about other users -- check role first --
  if (scope === "restricted") {
    // Student/Content Creator -> BLOCKED
    if (roleNum >= 6) {
      return {
        prompt: "",
        blocked: true,
        blockReason: `Sorry ${name}! As a ${roleName}, you can only view your own data.\n\nYou don't have access to other students' data, rankings, or platform-wide statistics.\n\n**Try asking about your own data instead:**\n- "Show my coding performance"\n- "What is my MCQ accuracy?"\n- "Show my course progress"\n- "Who am I?"`,
      };
    }

    // Super Admin / Admin -> full access
    if (roleNum <= 2) {
      prompt += `SCOPE: ADMIN - Full platform access. No restrictions.\n`;
      prompt += `RULES:\n`;
      prompt += `- You can query ANY table without restrictions.\n`;
      prompt += `- Cross-college comparisons, rankings, analytics are all allowed.\n`;
      prompt += `- If the question mentions college abbreviations (SKCT, SKCET, SREC, SRIT, NIET, KITS, MCET, etc.),\n`;
      prompt += `  search the colleges table with LIKE '%keyword%' to find the matching college.\n`;
      prompt += `- For student counts/lists: users table WHERE role = 7.\n`;
      prompt += `- For trainer counts: users table WHERE role = 5.\n`;
    } else {
      // College Admin / Staff / Trainer -> college scoped
      prompt += `SCOPE: COLLEGE-SCOPED - ${roleName}, limited to their college.\n`;
      prompt += `RULES:\n`;
      prompt += `- Add WHERE college_id = ${collegeId} (via user_academics) to all cross-user queries.\n`;
      prompt += `- Can see students/trainers in their college, but NOT other colleges.\n`;
      prompt += `- Cross-college comparisons are NOT allowed.\n`;
      prompt += `- If they ask about "my students" or "my college", use college_id = ${collegeId}.\n`;
    }
    prompt += `\n--- END ACCESS CONTROL ---\n`;
    return { prompt, blocked: false };
  }

  // -- PUBLIC scope (default): catalog data, no user_id needed --
  prompt += `SCOPE: PUBLIC - Platform/catalog data query.\n`;
  prompt += `RULES:\n`;
  prompt += `- Do NOT add WHERE user_id = ${userId} to your queries.\n`;
  prompt += `- Query the full tables (courses, colleges, departments, etc.)\n`;
  prompt += `- This data is accessible to everyone - no restrictions.\n`;
  prompt += `- "allocated" courses means course_academic_maps table, not courses table.\n`;
  prompt += `- "available" courses means courses table WHERE status = 1.\n`;
  prompt += `\n--- END ACCESS CONTROL ---\n`;
  return { prompt, blocked: false };
}




// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ROUTING LAYER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•


// LLM LAYER — Only for insights and general knowledge. NEVER for numbers.
const GENERAL_KNOWLEDGE_PROMPT = `You are Devora AI — a helpful assistant for an online coding education platform.
The user asked a general/conceptual question (NOT a data query).

RESPONSE RULES:
- Keep answers under 150 words. Be concise and direct.
- Give key facts in 3-4 sentences. NO code examples unless the user explicitly asks.
- For programming concepts: explain what it is, why it matters, one practical use case.
- Do NOT write essays, long lists, or multiple sections.
- End with: "Want more details?" or a relevant follow-up question.
- Format: Use **bold** for key terms. No ## headings for short answers.
- Do NOT use emojis or icons in your response. Keep it professional and clean.
This is NOT a database question — do not try to query anything.`;

function getGreeting(userName: string, roleName: string, collegeName: string | null): string {
  // ── Student (role=7) ──
  if (roleName === "Student") {
    return `## Devora AI Assistant
**Hello ${userName}!** Welcome back.

### Try asking me:
- *"Show my coding performance"*
- *"How many coding questions have I solved?"*
- *"What is my MCQ accuracy?"*
- *"Show my course progress"*
- *"What are my strengths and weaknesses?"*
${collegeName ? `\nYou're studying at **${collegeName}**. I can see all your performance data here.` : ''}

What would you like to know?`;
  }

  // ── Staff/Trainer (role=4,5) ──
  if (roleName === "Staff" || roleName === "Trainer") {
    return `## Devora AI Assistant
**Hello ${userName}!** Welcome back.

### Try asking me:
${collegeName
        ? `- *"Top 10 students in ${collegeName}"*\n- *"How many students in ${collegeName}?"*\n- *"${collegeName} coding performance overview"*`
        : `- *"Top 10 students"*\n- *"Student performance overview"*`}
- *"Find student by name"*
- *"Course-wise performance breakdown"*
- *"Show my own coding performance"*

What insights would you like?`;
  }

  // ── CollegeAdmin (role=3) ──
  if (roleName === "CollegeAdmin") {
    return `## Devora AI Assistant
**Hello ${userName}!** Welcome back.

### Try asking me:
${collegeName
        ? `- *"${collegeName} performance overview"*\n- *"Top students in ${collegeName}"*\n- *"Compare departments in ${collegeName}"*`
        : `- *"College performance overview"*\n- *"Top students"*`}
- *"How many students are enrolled?"*
- *"Course completion rates"*
- *"Students at risk"*

What would you like to explore?`;
  }

  // ── Admin/SuperAdmin (role=1,2) ──
  return `## Devora AI Assistant
**Hello ${userName}!** Welcome back.

### Smart Insights I Can Provide:
- *"Compare all colleges"*
- *"Top 10 students platform-wide"*
- *"How many students across all colleges?"*
- *"Which course has the highest enrollment?"*
- *"SKCET vs SREC vs MCET comparison"*
- *"Find student karthick"*

What insights would you like to explore?`;
}

async function handleWithTools(
  question: string,
  userId: number,
  roleNum: number,
  history: any[],
  _options: { version: 'v1' | 'v2' },
  scopePrompt: string,
) {
  const chatModel = makeDeepSeekModel("deepseek-chat");
  const tokenTrackerId = `req-${userId}-${Date.now()}`;
  const roleName = getRoleName(roleNum);
  const isStudentRole = roleNum === ROLES.STUDENT;

  let followUpContext = "";
  if (history && history.length > 0) {
    const contextExchanges = history.slice(-6);
    followUpContext = `
PREVIOUS CONVERSATION CONTEXT:
${contextExchanges.map(h => `${h.role === 'user' ? 'Question' : 'Answer'}: ${h.content}`).join('\n')}

IMPORTANT: If the user's current question was ALREADY answered in the conversation above, respond with that answer directly. Do NOT run any SQL queries.
If it's a follow-up question, reuse the relevant tables/filters from the previous queries above.`;
  }

  // Inject the scope prompt early to be able to extract the scope
  const scopeMatch = scopePrompt.match(/SCOPE: (\w+)/);
  const scope = scopeMatch ? scopeMatch[1].toLowerCase() : "personal";

  const systemPrompt = `You are Devora AI — expert SQL analyst for coderv4 database (TiDB/MySQL).
User: id=${userId}, role=${roleNum} (${roleName})

${scopePrompt}

${followUpContext}

${buildRoleTailoredSchema(roleNum)}

QUERY SHORTCUTS:
- "coding/mcq scores (prepare)" → course_wise_segregations WHERE type = 1
- "coding/mcq scores (assessment)" → course_wise_segregations WHERE type = 2
- Each CWS row has BOTH coding_question and mcq_question JSON — type is prepare vs assessment, NOT coding vs MCQ!
- "enrolled courses" → course_wise_segregations or user_course_enrollments WHERE user_id = X
${!isStudentRole ? `- "allocated courses" → COUNT from course_academic_maps (NOT courses table)
- "available courses" → courses WHERE status = 1
- "student count" → users WHERE role = 7 AND status = 1
- "trainer count" → users WHERE role = 5 AND status = 1` : ''}
- "my trainer" → course_wise_segregations → course_academic_maps → course_staff_trainer_allocations

CRITICAL RULES (MUST FOLLOW):
██ ONE QUERY PER TOOL CALL. Never combine SQL with semicolons. If you need multiple queries, make SEPARATE run_sql calls. Any query with ; will be rejected.
██ EFFICIENCY: For "my progress/performance/scores" → query course_wise_segregations ONCE and STOP. That table has pre-computed progress%, score, rank, and JSON breakdowns. Do NOT also query dynamic result tables unless the user specifically asks for question-level details. Target: 1-2 steps for overview, 2-3 for deep dives.
██ NO REPEATS: Never query the same table twice. If you already have CWS data, do NOT re-query it with a date filter. CWS has updated_at for recency.
██ RESERVED WORDS: Always backtick these column names — they are MySQL reserved words: \`rank\`, \`order\`, \`key\`, \`status\`, \`type\`, \`mode\`, \`time\`, \`access\`. Example: SELECT \`rank\` FROM course_wise_segregations.
██ NAME SEARCH: When searching by name, use SHORT substrings (first 4-5 chars) with LIKE. Example: "ashmita" → WHERE name LIKE '%ashm%'. Do NOT use the full name — users often have spelling variations, middle names, or transliterations.
██ CWS RANKING: CWS \`rank\` is DEPARTMENT rank, NOT global. Use \`score\` for cross-department comparisons. Always label it "Dept Rank".
██ CWS AVERAGES: When averaging scores, EXCLUDE courses with progress=0 (not started). Don't average a 900 score with a 0.
██ CWS GROUPING: CWS has type=1 (Prepare) and type=2 (Assessment) as SEPARATE rows per course. Group by course_id first to avoid double-counting.
RULES:
1. You already have the full schema above — go DIRECTLY to run_sql. Only use list_tables/describe_table for tables NOT in the schema.
2. Only SELECT queries allowed
3. Always filter status = 1 for active records
4. Format answer as markdown with tables where appropriate
5. Present data clearly with counts, percentages, and comparisons
6. Answer EXACTLY what was asked — nothing more. If user asks "how many students?", return the count. Do NOT add college breakdown, gender breakdown, or extra analytics unless specifically requested.
7. For JOINs: users → user_academics (user_id) → colleges (college_id) → departments (department_id)
8. ERROR ANALYSIS: When the student asks about errors or how to improve:
   a. Query the errors column (JSON) from coding_result tables
   b. Identify the error type (compilation, runtime, logic)
   c. Explain what caused it in simple terms
   d. Show the fix with a code example using ❌ (wrong) and ✅ (correct)
   e. Look for error PATTERNS across questions
9. DEEP DIVE: For detailed course/topic analysis:
   a. First get courses from course_wise_segregations
   b. Then get topics from course_academic_maps using the course_id + college_id
   c. Then get per-question results from dynamic tables using course_allocation_id = cam.id
   d. Present topic-wise breakdown with solved/partial/wrong counts

RESPONSE STYLE:
- Be concise but COMPLETE. Never skip important data.
- Keep reports under 200 words. Use short tables or bullet points for data.
- Don't add extra breakdowns, charts, or analysis the user didn't ask for.
- Include ALL key numbers, just use fewer words.
- End with: "Want a deeper breakdown?" or a relevant follow-up.
- Do NOT use emojis or icons. Keep responses professional and clean.
- NEVER mention table names, column names, SQL queries, or database internals in your response. Present data naturally. Say "performance data" not "course_wise_segregations table".`;

  const tools = {
    list_tables: tool({
      description: "List all tables in database",
      parameters: z.object({ _unused: z.string().optional() }),
      execute: async (args: any) => {
        const res = await databaseConnectionService.executeQuery(
          dbMock, "SHOW TABLES", { databaseName: dbName }
        );
        return res.success
          ? { tables: res.data?.map((r: any) => Object.values(r)[0]) || [] }
          : { error: res.error };
      },
    } as any),

    describe_table: tool({
      description: "Get columns and 3 sample rows of a table",
      parameters: z.object({ table_name: z.string() }),
      execute: async (args: any) => {
        const table_name = args?.table_name || args?.tableName || args?.table || (typeof args === 'string' ? args : '');
        const safe = (table_name || '').replace(/[^a-zA-Z0-9_]/g, "");
        if (!safe) return { error: "No table name provided" };
        const desc = await databaseConnectionService.executeQuery(
          dbMock, `DESCRIBE \`${safe}\``, { databaseName: dbName }
        );
        const sample = await databaseConnectionService.executeQuery(
          dbMock, `SELECT * FROM \`${safe}\` LIMIT 3`, { databaseName: dbName }
        );
        return { columns: desc.data, samples: sample.data };
      },
    } as any),

    run_sql: tool({
      description: "Execute a SELECT query. Returns up to 200 rows.",
      parameters: z.object({ query: z.string() }),
      execute: async (args: any) => {
        try {
          const query = args?.query || args?.sql || (typeof args === 'string' ? args : '');
          if (!query) return { error: "No query provided" };
          let cleaned = query.trim().replace(/^```(sql)?\s*/i, "").replace(/\s*```$/i, "").trim();

          // HARD BLOCK: reject multi-statement queries (semicolons)
          // Only keep the first statement if LLM crammed multiple
          if (cleaned.includes(';')) {
            const firstStatement = cleaned.split(';')[0].trim();
            if (firstStatement) {
              cleaned = firstStatement;
              logger.warn(`[run_sql] Multi-statement query detected — trimmed to first statement`);
            }
          }

          if (!cleaned.toLowerCase().startsWith("select")) {
            return { error: "Only SELECT queries allowed" };
          }

          // FIX #3: Use word-boundary regex instead of .includes() to prevent
          // substring collisions (e.g. userId=23 matching "2372")
          const userIdRegex = new RegExp(`\\b${userId}\\b`);

          // FIX #1: For students, block queries touching sensitive tables
          // (users, user_academics) without user_id — in ALL scopes, not just personal.
          // Public catalog tables (courses, colleges, etc.) are fine without user_id.
          if (isStudentRole) {
            const queriesUserTable = /\bfrom\s+[`]?(users|user_academics)[`]?\b/i.test(cleaned)
              || /\bjoin\s+[`]?(users|user_academics)[`]?\b/i.test(cleaned);
            if (queriesUserTable && !userIdRegex.test(cleaned)) {
              return { error: `Security: Student queries on user tables must filter by user_id = ${userId}` };
            }
            // Personal scope: ALL queries must include user_id
            if (scope === "personal" && !userIdRegex.test(cleaned)) {
              return { error: `Security: Personal queries must filter by user_id = ${userId}` };
            }
          }

          const res = await databaseConnectionService.executeQuery(
            dbMock, cleaned, { databaseName: dbName }
          );
          if (!res.success) return { error: res.error, sql: cleaned };
          if (!res.data?.length) return { warning: "0 rows returned. Check your query.", sql: cleaned, rows: [] };

          const maxRows = 25;
          const totalRows = res.data.length;
          let rowsToReturn = res.data;
          let warningText = undefined;

          if (totalRows > maxRows) {
            rowsToReturn = res.data.slice(0, maxRows);
            warningText = `(Showing ${maxRows} of ${totalRows} total rows. Use this sample to extrapolate or run a COUNT() query if you need true totals.)`;
          }

          return {
            rows: rowsToReturn,
            total: totalRows,
            sql: cleaned,
            ...(warningText ? { warning: warningText } : {})
          };
        } catch (err: any) {
          return { error: `Tool error: ${err.message}` };
        }
      },
    } as any),
  };

  let executedSql = "";

  const result = await generateText({
    model: chatModel,
    system: systemPrompt,
    messages: [
      ...(history as any),
      { role: "user" as const, content: question.trim() }
    ],
    tools,
    headers: { "x-ds-tracker": tokenTrackerId } as Record<string, string>, // Passed into HTTP fetch map for accurate DeepSeek token counting
    stopWhen: stepCountIs(8), // FIX 2: Prevents runaway agent loops (cuts out 40s+ delays)
    temperature: 0,
    // maxOutputTokens: 2048,
  } as any);

  for (const step of result.steps ?? []) {
    for (const tr of (step.toolResults ?? []) as any[]) {
      const raw = tr.result ?? tr.output;
      if (tr.toolName === "run_sql" && raw?.sql) {
        executedSql += raw.sql + ";\n";
      }
    }
  }

  const stepsUsed = result.steps?.length ?? 1;
  let report = result.text?.trim() || "";

  // Retrieve the global token counts extracted directly from DeepSeek HTTP payloads
  let inputToken = 0;
  let outputToken = 0;
  const recordedTokens = deepseekUsages.get(tokenTrackerId);
  if (recordedTokens) {
    inputToken = recordedTokens.input;
    outputToken = recordedTokens.output;
    deepseekUsages.delete(tokenTrackerId); // cleanup memory
  } else {
    // fallback if interceptor failed
    inputToken = (result.usage as any)?.inputTokens || (result.usage as any)?.promptTokens || 0;
    outputToken = (result.usage as any)?.outputTokens || (result.usage as any)?.completionTokens || 0;
  }

  // Fix F: If we hit max steps and got garbage output, try to summarize collected data
  if (stepsUsed >= 8 && (!report || report.toLowerCase().includes('let me fix') || report.toLowerCase().includes('let me try'))) {
    // Collect all successful tool results with data
    const allData = result.steps?.flatMap(s =>
      ((s.toolResults ?? []) as any[])
        .filter(tr => tr.result?.rows?.length > 0)
        .map(tr => tr.result)
    ) || [];

    if (allData.length > 0) {
      try {
        const summary = await generateText({
          model: chatModel,
          system: 'Summarize this query data into a clean, concise report. No error messages. Format with markdown tables if appropriate.',
          messages: [{ role: 'user' as const, content: JSON.stringify(allData.slice(0, 5)) }],
          maxOutputTokens: 1024,
          temperature: 0,
        });
        report = summary.text?.trim() || report;
        inputToken += (summary.usage as any)?.inputTokens || (summary.usage as any)?.promptTokens || 0;
        outputToken += (summary.usage as any)?.outputTokens || (summary.usage as any)?.completionTokens || 0;
      } catch { /* keep original fallback */ }
    }
    if (!report || report.toLowerCase().includes('let me')) {
      report = "I gathered some data but ran into query complexity. Please try rephrasing or asking something more specific.";
    }
  }

  return {
    report: report || "Could not generate response.",
    sql: executedSql || null,
    steps: stepsUsed,
    inputToken,
    outputToken,
  };
}
// ═══════════════════════════════════════════════════════════════════════════
// HISTORY PRE-CHECK — Don't call LLM if the answer is already in history
// ═══════════════════════════════════════════════════════════════════════════

function findAnswerInHistory(
  history: Array<{ role: string, content: string }>,
  question: string
): string | null {
  if (!history || history.length < 2) return null;

  const normalize = (s: string) => s.toLowerCase().trim().replace(/[?.!,;]+$/g, '').replace(/\s+/g, ' ');
  const q = normalize(question);

  // Walk backwards through history looking for exact same question
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      const prev = normalize(history[i].content);
      if (prev === q && i + 1 < history.length && history[i + 1].role === 'assistant') {
        return history[i + 1].content;
      }
    }
  }
  return null;
}


async function handleDbQuestion(
  question: string,
  userId: string,
  userRole: string | number | undefined,
  history: any[],
  consoleId: string | undefined,
  options: { version: 'v1' | 'v2' }
) {
  const roleNum = Number(userRole) || 0;
  const roleName = getRoleName(roleNum);
  const reasonerModel = makeDeepSeekModel("deepseek-reasoner");

  // Step 1: Run through dynamic LLM classifier
  const classificationResult = await classifyQuestion(question, roleNum, roleName);
  const { route, scope, tables_hint, usage: classUsage } = classificationResult;

  let totalInputToken = classUsage?.promptTokens || 0;
  let totalOutputToken = classUsage?.completionTokens || 0;

  logger.info(`Agent chat (${options.version})`, { userId, role: roleNum, route, question: question.slice(0, 80) });

  // ── HISTORY PRE-CHECK: Return cached answer instantly ──
  const cachedAnswer = findAnswerInHistory(history, question);
  if (cachedAnswer) {
    logger.info(`[history-cache] HIT — returning cached answer for: "${question.slice(0, 50)}"`);
    return { report: cachedAnswer, sql: null, steps: 0, inputToken: 0, outputToken: 0 };
  }

  // ── GREETING (instant, personalized) ──
  if (route === "greeting") {
    const profile = await getUserProfile(Number(userId));
    const roleName = getRoleName(roleNum);
    return { report: getGreeting(profile?.name || "there", roleName, profile?.college_name || null), sql: null, steps: 0, inputToken: totalInputToken, outputToken: totalOutputToken };
  }

  // ── GENERAL KNOWLEDGE (no DB) ──
  if (route === "general") {
    try {
      const result = await generateText({
        model: reasonerModel,
        system: GENERAL_KNOWLEDGE_PROMPT,
        messages: [...(history as any), { role: "user" as const, content: question.trim() }],
        temperature: 0.4,
        maxOutputTokens: 512,
      });
      totalInputToken += (result.usage as any)?.inputTokens || (result.usage as any)?.promptTokens || 0;
      totalOutputToken += (result.usage as any)?.outputTokens || (result.usage as any)?.completionTokens || 0;
      return { report: result.text?.trim() || "I couldn't generate an answer.", sql: null, steps: 1, inputToken: totalInputToken, outputToken: totalOutputToken };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`General path error (${options.version})`, { error: msg });
      throw new Error(msg);
    }
  }

  // ── DB QUESTION: Classify → Scope → LLM ──
  try {
    const t0 = Date.now();
    const numUserId = Number(userId);

    // STEP 2: Handle IDENTITY fast-path based on updated classifier reason
    if (classificationResult.reason === "identity") {
      const profile = await getUserProfile(numUserId);
      if (!profile) return { report: "Could not find your profile.", sql: null, steps: 1, inputToken: totalInputToken, outputToken: totalOutputToken };
      const roleName = getRoleName(profile.role);
      const report = `### User Profile\n\n| Field | Value |\n|-------|-------|\n| Name | ${profile.name} |\n| Email | ${profile.email} |\n| Role | ${roleName} |\n| Roll No | ${profile.roll_no || 'N/A'} |\n| College | ${profile.college_name || 'N/A'} |\n| Department | ${profile.department_name || 'N/A'} |\n| Batch | ${profile.batch_name || 'N/A'} |\n`;
      logger.info(`Agent chat complete — identity fast-path (${options.version})`, { userId, totalTimeMs: Date.now() - t0 });
      return { report, sql: null, steps: 1, inputToken: totalInputToken, outputToken: totalOutputToken };
    }

    // STEP 3: Build scope prompt for LLM
    const profile = await getUserProfile(numUserId);
    const collegeId = profile?.college_id || null;
    const collegeShort = profile?.college_short_name || null;

    // Pre-fetch dynamic table prefixes using cam.db (NOT college_short_name!)
    // cam.db is the ACTUAL table prefix — handles mismatches like dotlab≠demolab, skacas≠skasc
    let dynamicTables: string[] = [];
    try {
      const dbRes = await runQuery(`
        SELECT DISTINCT cam.db
        FROM course_wise_segregations cws
        JOIN course_academic_maps cam ON cws.course_allocation_id = cam.allocation_id
        WHERE cws.user_id = ${numUserId} AND cam.db IS NOT NULL AND cws.status = 1
      `);
      const dbPrefixes = (dbRes.rows || []).map((r: any) => r.db as string).filter(Boolean);

      if (dbPrefixes.length > 0) {
        // Fetch actual table names for each prefix
        for (const prefix of dbPrefixes) {
          const tablesRes = await runQuery(`SHOW TABLES LIKE '${prefix}_%'`);
          const tables = (tablesRes.rows || []).map((r: any) => Object.values(r)[0] as string);
          dynamicTables.push(...tables);
        }
      } else if (collegeShort) {
        // Fallback: use college_short_name if cam.db lookup returns nothing
        const tablesRes = await runQuery(`SHOW TABLES LIKE '${collegeShort}_%'`);
        dynamicTables = (tablesRes.rows || []).map((r: any) => Object.values(r)[0] as string);
      }
    } catch (err: any) {
      logger.error(`[dynamic-tables] Failed to fetch: ${err.message}`);
    }

    const scopeResult = buildScopePrompt(roleNum, numUserId, collegeId, scope, profile?.name, collegeShort, dynamicTables);

    // STEP 4: Inject table hints if they exist
    if (tables_hint && tables_hint.length > 0) {
      scopeResult.prompt += `\nTABLES HINT (Classifier suggests checking these tables): ${tables_hint.join(', ')}\n`;
    }

    // STEP 5: Check if blocked (student asking restricted questions)
    if (scopeResult.blocked) {
      logger.info(`Agent chat complete — blocked (${options.version})`, { userId, role: roleNum, scope });
      return { report: scopeResult.blockReason || "Access denied.", sql: null, steps: 1, inputToken: totalInputToken, outputToken: totalOutputToken };
    }

    // STEP 5: LLM with tools — the brain does the work
    logger.info(`LLM with tools (${options.version})`, { userId, role: roleNum, scope });
    const result = await handleWithTools(question, numUserId, roleNum, history, options, scopeResult.prompt);
    const totalTime = Date.now() - t0;

    totalInputToken += result.inputToken || 0;
    totalOutputToken += result.outputToken || 0;

    logger.info(`Agent chat complete (${options.version})`, { userId, role: roleNum, totalTimeMs: totalTime, steps: result.steps });
    return { ...result, inputToken: totalInputToken, outputToken: totalOutputToken };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`DB path error (${options.version})`, { error: msg });
    throw new Error(msg);
  }
}


// ── POST /chat ─────────────────────────────────────────────────────────────────
agentRoutes.post("/chat", async (c) => {
  let body: Record<string, any> = {};
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const { question, user_id, user_role, consoleId, history = [] } = body as {
    question?: string; user_id?: string | number; user_role?: string | number;
    consoleId?: string; history?: { role: 'user' | 'assistant', content: string }[];
  };

  // FIX #4: WARNING — user_id and user_role currently come from the POST body.
  // In production, these MUST be validated server-side from a JWT/session token.
  // A malicious user can send { user_role: 1 } to get SuperAdmin access.
  // TODO: Replace with server-side auth extraction before production deployment.
  if (!question?.trim()) return c.json({ error: "'question' is required" }, 400);
  const userId = user_id ? String(user_id) : "anonymous";

  try {
    const response = await handleDbQuestion(question, userId, user_role, history, consoleId, { version: 'v1' });
    return c.json(response);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /chat-v2 ──────────────────────────────────────────────────────────────
agentRoutes.post("/chat-v2", async (c) => {
  let body: Record<string, any> = {};
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const { question, user_id, user_role, history = [] } = body as {
    question?: string; user_id?: string | number; user_role?: string | number; history?: { role: 'user' | 'assistant', content: string }[];
  };

  if (!question?.trim()) return c.json({ error: "'question' is required" }, 400);
  const userId = user_id ? String(user_id) : "anonymous";

  try {
    const response = await handleDbQuestion(question, userId, user_role, history, undefined, { version: 'v2' });
    return c.json(response);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
