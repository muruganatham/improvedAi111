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
import { classifyQuestionScope } from "../agent-lib/question-classifier";

const logger = loggers.agent();
export const agentRoutes = new Hono();

const dbName = process.env.DB_NAME || "coderv4";
const dbMock = { _id: "000000000000000000000002", type: "mysql" } as any;

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
let cachedSchemaPrompt = "";

const SCHEMA_TABLES = [
  'users', 'user_academics', 'colleges', 'departments',
  'batches', 'sections', 'courses', 'course_academic_maps',
  'course_wise_segregations', 'user_course_enrollments',
  'course_staff_trainer_allocations', 'institutions',
  'practice_modules', 'topics', 'sections'
];

async function loadSchemaCache() {
  try {
    let schema = "DATABASE SCHEMA (live from DB — use these columns directly):\n";
    for (const table of SCHEMA_TABLES) {
      const res = await runQuery(`DESCRIBE \`${table}\``);
      if (res.rows && res.rows.length > 0) {
        const columns = res.rows.map((r: any) => r.Field).join(', ');
        schema += `- ${table}: ${columns}\n`;
      }
    }
    schema += `\nENUM VALUES (use EXACT numbers, never strings):\n`;
    schema += `- users.role: 1=SuperAdmin, 2=Admin, 3=CollegeAdmin, 4=Staff, 5=Trainer, 6=ContentCreator, 7=Student\n`;
    schema += `- users.gender: 1=Male, 2=Female, 3=Other (NULL/0=not set)\n`;
    schema += `- course_wise_segregations.type: 1=Coding, 2=MCQ\n`;
    schema += `- courses.category: 1=Foundation, 2=Advanced, 3=Specialized\n`;
    schema += `- status column (ALL tables): 1=active. Always add WHERE status=1.\n`;

    schema += `\nDYNAMIC TABLES (per-college, per-semester):\n`;
    schema += `Pattern: {college_short_name}_{year}_{sem}_{type}\n`;
    schema += `Example: srec_2026_1_coding_result, skcet_2025_2_mcq_result\n`;
    schema += `Find tables: SHOW TABLES LIKE '{short_name}_%_coding_result'\n\n`;

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
    schema += `- "allocated courses" → COUNT from course_academic_maps (NOT courses table)\n`;
    schema += `- "available courses" → courses WHERE status = 1\n`;
    schema += `- "enrolled courses" / "my scores" → course_wise_segregations WHERE user_id = X\n`;
    schema += `- "my trainer" → course_wise_segregations → course_academic_maps → course_staff_trainer_allocations\n`;
    schema += `- Student progress/scores (aggregated) → course_wise_segregations (best table)\n`;
    schema += `- Per-question details → dynamic coding_result/mcq_result tables\n`;
    cachedSchemaPrompt = schema;
    logger.info(`[schema-cache] Cached ${SCHEMA_TABLES.length} table schemas`);
  } catch (err: any) {
    logger.error(`[schema-cache] Failed to load schema: ${err.message}`);
  }
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
    LEFT JOIN user_academics ua ON ua.user_id = u.id AND ua.college_id IS NOT NULL
    LEFT JOIN colleges c ON c.id = ua.college_id
    LEFT JOIN departments d ON d.id = ua.department_id
    LEFT JOIN batches b ON b.id = ua.batch_id
    WHERE u.id = ${isNaN(Number(userId)) ? 0 : Number(userId)} LIMIT 1
  `);
  return res.rows?.[0] || null;
}

// ── Cached table list helpers (30 min TTL — tables rarely change) ─────────────
async function getAllCodingTables(): Promise<string[]> {
  const cached = getCached('all_coding_tables');
  if (cached) return cached;
  const res = await runQuery("SHOW TABLES LIKE '%\\_coding\\_result'");
  const tables = (res.rows || []).map((r: any) => Object.values(r)[0] as string);
  setCache('all_coding_tables', tables, 30 * 60_000);
  return tables;
}

async function getAllMcqTables(): Promise<string[]> {
  const cached = getCached('all_mcq_tables');
  if (cached) return cached;
  const res = await runQuery("SHOW TABLES LIKE '%\\_mcq\\_result'");
  const tables = (res.rows || []).map((r: any) => Object.values(r)[0] as string);
  setCache('all_mcq_tables', tables, 30 * 60_000);
  return tables;
}

async function getAllTestTables(): Promise<string[]> {
  const cached = getCached('all_test_tables');
  if (cached) return cached;
  const res = await runQuery("SHOW TABLES LIKE '%\\_test\\_data'");
  const tables = (res.rows || []).map((r: any) => Object.values(r)[0] as string);
  setCache('all_test_tables', tables, 30 * 60_000);
  return tables;
}

// ── Coding summary (cached 5 min) ─────────────────────────────────────────────
async function getCodingSummary(userId: number) {
  const cached = getCached(`coding_${userId}`);
  if (cached) return cached;

  const tables = await getAllCodingTables();

  if (tables.length === 0) return { total_attended: 0, fully_solved: 0, partially_solved: 0, attempted_not_solved: 0, solve_rate: "0.00%", sources: [], sql: "" };

  const unionSql = tables.map((t: string) => `
    SELECT '${t}' AS source,
      COUNT(*) AS total_attended,
      SUM(CASE WHEN solve_status = 2 THEN 1 ELSE 0 END) AS fully_solved,
      SUM(CASE WHEN solve_status = 1 THEN 1 ELSE 0 END) AS partially_solved,
      SUM(CASE WHEN solve_status = 3 THEN 1 ELSE 0 END) AS attempted_not_solved
    FROM \`${t}\` WHERE user_id = ${Number(userId)} AND status = 1
  `).join(" UNION ALL ");

  const res = await runQuery(unionSql);
  const rows = (res.rows || []).filter((r: any) => Number(r.total_attended) > 0);

  const totals = {
    total_attended: rows.reduce((s: number, r: any) => s + Number(r.total_attended), 0),
    fully_solved: rows.reduce((s: number, r: any) => s + Number(r.fully_solved), 0),
    partially_solved: rows.reduce((s: number, r: any) => s + Number(r.partially_solved), 0),
    attempted_not_solved: rows.reduce((s: number, r: any) => s + Number(r.attempted_not_solved), 0),
  };
  const solveRate = totals.total_attended > 0
    ? ((totals.fully_solved / totals.total_attended) * 100).toFixed(2) + "%"
    : "0.00%";

  const result = { ...totals, solve_rate: solveRate, sources: rows, sql: unionSql };
  setCache(`coding_${userId}`, result);
  return result;
}

// ── MCQ summary (cached 5 min) ────────────────────────────────────────────────
async function getMcqSummary(userId: number) {
  const cached = getCached(`mcq_${userId}`);
  if (cached) return cached;

  const tables = await getAllMcqTables();

  if (tables.length === 0) return { total_attended: 0, correct: 0, wrong: 0, accuracy: "0.00%", sources: [], sql: "" };

  const unionSql = tables.map((t: string) => `
    SELECT '${t}' AS source,
      COUNT(*) AS total_attended,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct,
      SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) AS wrong
    FROM \`${t}\` WHERE user_id = ${Number(userId)} AND status = 1
  `).join(" UNION ALL ");

  const res = await runQuery(unionSql);
  const rows = (res.rows || []).filter((r: any) => Number(r.total_attended) > 0);

  const totals = {
    total_attended: rows.reduce((s: number, r: any) => s + Number(r.total_attended), 0),
    correct: rows.reduce((s: number, r: any) => s + Number(r.correct), 0),
    wrong: rows.reduce((s: number, r: any) => s + Number(r.wrong), 0),
  };
  const accuracy = totals.total_attended > 0
    ? ((totals.correct / totals.total_attended) * 100).toFixed(2) + "%"
    : "0.00%";

  const result = { ...totals, accuracy, sources: rows, sql: unionSql };
  setCache(`mcq_${userId}`, result);
  return result;
}

// ── Test score summary (cached 5 min) ─────────────────────────────────────────
async function getTestScoreSummary(userId: number) {
  const cached = getCached(`test_${userId}`);
  if (cached) return cached;

  const tables = await getAllTestTables();

  if (tables.length === 0) return { sources: [], sql: "" };

  const unionSql = tables.map((t: string) => `
    SELECT '${t}' AS source,
      COUNT(*) AS modules_attempted,
      ROUND(SUM(JSON_EXTRACT(mark, '$.co')) * 100.0 / NULLIF(SUM(JSON_EXTRACT(total_mark, '$.co')), 0), 2) AS coding_pct,
      ROUND(SUM(JSON_EXTRACT(mark, '$.mcq')) * 100.0 / NULLIF(SUM(JSON_EXTRACT(total_mark, '$.mcq')), 0), 2) AS mcq_pct
    FROM \`${t}\` WHERE user_id = ${Number(userId)} AND status = 1
  `).join(" UNION ALL ");

  const res = await runQuery(unionSql);
  const rows = (res.rows || []).filter((r: any) => Number(r.modules_attempted) > 0);

  const result = { sources: rows, sql: unionSql };
  setCache(`test_${userId}`, result);
  return result;
}

// ── College comparison (with optional single-college filter) ──────────────────
async function getCollegeComparison(collegeId?: number) {
  let whereClause = "WHERE c.status = 1";
  if (collegeId) whereClause += ` AND c.id = ${Number(collegeId)}`;

  const sql = `
    SELECT c.id, c.college_name, c.college_short_name,
      COUNT(DISTINCT ua.user_id) AS student_count
    FROM colleges c
    LEFT JOIN user_academics ua ON ua.college_id = c.id
    LEFT JOIN users u ON u.id = ua.user_id AND u.role = 7 AND u.status = 1
    ${whereClause}
    GROUP BY c.id, c.college_name, c.college_short_name
    ORDER BY student_count DESC
  `;
  const res = await runQuery(sql);
  return { colleges: res.rows, sql };
}

// ── Student count (with optional college filter) ──────────────────────────────
async function getStudentCount(collegeFilter?: string, collegeId?: number) {
  let sql: string;
  if (collegeId) {
    sql = `
      SELECT COUNT(DISTINCT u.id) AS total
      FROM users u
      JOIN user_academics ua ON ua.user_id = u.id
      WHERE u.role = 7 AND u.status = 1 AND ua.college_id = ${Number(collegeId)}
    `;
  } else if (collegeFilter) {
    sql = `
      SELECT COUNT(DISTINCT u.id) AS total
      FROM users u
      JOIN user_academics ua ON ua.user_id = u.id
      JOIN colleges c ON c.id = ua.college_id
      WHERE u.role = 7 AND u.status = 1
        AND (c.college_name LIKE '%${collegeFilter}%' OR c.college_short_name LIKE '%${collegeFilter}%')
    `;
  } else {
    sql = `SELECT COUNT(*) AS total FROM users WHERE role = 7 AND status = 1`;
  }
  const res = await runQuery(sql);
  return { count: res.rows[0]?.total ?? 0, sql };
}

// ── Courses for a user ────────────────────────────────────────────────────────
async function getUserCourses(userId: number) {
  const sql = `
    SELECT c.course_name, c.course_short_name, cws.score, cws.progress, cws.type,
      col.college_name
    FROM course_wise_segregations cws
    JOIN courses c ON c.id = cws.course_id
    LEFT JOIN colleges col ON col.id = cws.college_id
    WHERE cws.user_id = ${Number(userId)} AND cws.status = 1
  `;
  const res = await runQuery(sql);
  return { courses: res.rows, sql };
}

// ── Search users (with optional college scoping) ──────────────────────────────
async function searchUser(searchTerm: string, collegeId?: number) {
  // Fix #9: Escape backslashes AND single quotes to prevent SQL injection
  const safe = searchTerm.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[%_]/g, c => '\\' + c);
  let collegeJoin = "";
  let collegeWhere = "";
  if (collegeId) {
    collegeJoin = "JOIN user_academics ua2 ON ua2.user_id = u.id";
    collegeWhere = `AND ua2.college_id = ${Number(collegeId)}`;
  }
  const sql = `
    SELECT u.id, u.name, u.email, u.role, u.roll_no, u.status,
      c.college_name, d.department_name, b.batch_name
    FROM users u
    LEFT JOIN user_academics ua ON ua.user_id = u.id
    LEFT JOIN colleges c ON c.id = ua.college_id
    LEFT JOIN departments d ON d.id = ua.department_id
    LEFT JOIN batches b ON b.id = ua.batch_id
    ${collegeJoin}
    WHERE (u.name LIKE '%${safe}%' OR u.email LIKE '%${safe}%' OR u.roll_no LIKE '%${safe}%')
    ${collegeWhere}
    LIMIT 20
  `;
  const res = await runQuery(sql);
  return { users: res.rows, sql };
}

// ── Top students (with optional college scoping) ──────────────────────────────
async function getTopStudents(collegeFilter?: string, limit: number = 10, collegeId?: number) {
  const tablesRes = await runQuery("SHOW TABLES LIKE '%\\_test\\_data'");
  const tables = (tablesRes.rows || []).map((r: any) => Object.values(r)[0] as string);

  if (tables.length === 0) return { students: [], sql: "" };

  let filteredTables = tables;
  if (collegeFilter) {
    const lc = collegeFilter.toLowerCase();
    filteredTables = tables.filter((t: string) => t.toLowerCase().startsWith(lc));
    if (filteredTables.length === 0) filteredTables = tables;
  }

  const unionPart = filteredTables.map((t: string) => `
    SELECT user_id,
      JSON_EXTRACT(mark, '$.co') AS co, JSON_EXTRACT(total_mark, '$.co') AS co_total,
      JSON_EXTRACT(mark, '$.mcq') AS mcq, JSON_EXTRACT(total_mark, '$.mcq') AS mcq_total
    FROM \`${t}\` WHERE status = 1
  `).join(" UNION ALL ");

  let collegeWhere = "";
  if (collegeId) {
    collegeWhere = `AND ua.college_id = ${Number(collegeId)}`;
  }

  const sql = `
    WITH all_scores AS (${unionPart})
    SELECT u.name, u.email, u.roll_no, col.college_name,
      ROUND(SUM(a.co) * 100.0 / NULLIF(SUM(a.co_total), 0), 2) AS coding_pct,
      ROUND(SUM(a.mcq) * 100.0 / NULLIF(SUM(a.mcq_total), 0), 2) AS mcq_pct,
      ROUND((SUM(a.co) + SUM(a.mcq)) * 100.0 / NULLIF(SUM(a.co_total) + SUM(a.mcq_total), 0), 2) AS overall_pct,
      COUNT(*) AS modules
    FROM all_scores a
    JOIN users u ON u.id = a.user_id AND u.role = 7 AND u.status = 1
    LEFT JOIN user_academics ua ON ua.user_id = u.id
    LEFT JOIN colleges col ON col.id = ua.college_id
    WHERE 1=1 ${collegeWhere}
    GROUP BY a.user_id, u.name, u.email, u.roll_no, col.college_name
    HAVING modules >= 3
    ORDER BY overall_pct DESC
    LIMIT ${Number(limit)}
  `;

  const res = await runQuery(sql);
  return { students: res.rows, sql };
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SCOPE PROMPT BUILDER — Guide the LLM, don't replace it
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
): { prompt: string; blocked: boolean; blockReason?: string } {
  const roleName = getRoleName(roleNum);
  const sqlScope = getSQLScope(roleNum, userId, collegeId);
  const name = userName || 'User';

  let prompt = `\n--- ACCESS CONTROL ---\n`;
  prompt += `Current user: ${name} (${roleName}, user_id=${userId})\n\n`;

  // Security rules apply to ALL roles
  prompt += `SECURITY RULES (apply to ALL roles):\n`;
  prompt += `- NEVER return passwords, tokens, API keys, OTPs from any table.\n`;
  prompt += `- NEVER expose password columns even if asked directly.\n\n`;

  // -- PERSONAL scope: user asking about their own data --
  if (scope === "personal") {
    prompt += `SCOPE: PERSONAL - This user is asking about their OWN data.\n`;
    prompt += `RULES:\n`;
    prompt += `- ALWAYS add WHERE user_id = ${userId} to filter for this user's data.\n`;
    prompt += `- ONLY return THIS user's data.\n`;
    prompt += `- Do NOT fetch profile data (name, email, roll_no, college) unless the user specifically asks for it.\n`;
    prompt += `- For "who am I" questions: query users + user_academics (name, email, roll_no, college, department, batch).\n`;
    prompt += `- For "my scores/progress": query course_wise_segregations WHERE user_id = ${userId}.\n`;
    prompt += `- For "my trainer": find via course_wise_segregations -> course_academic_maps -> course_staff_trainer_allocations.\n`;
    prompt += `- For "my courses/enrolled": query course_wise_segregations WHERE user_id = ${userId} AND status = 1.\n`;
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

function preRouteQuestion(q: string): "general" | "db" | "greeting" {
  const lower = q.toLowerCase().trim();

  const greetingPatterns = [
    /^(hi|hello|hey|greetings|good morning|good afternoon|good evening)[^a-z0-9]*$/i
  ];
  if (greetingPatterns.some(p => p.test(lower))) return "greeting";

  const placementPatterns = [
    /\beligib(le|ility)\b/, /\bplacement\b/, /\bcampus (drive|hiring|recruit)\b/,
    /\bhiring\b/, /\brecruit(ment|ing)?\b/, /\bpackage\b/, /\bsalary\b/, /\blpa\b/,
    /\bcutoff\b/, /\bcut.?off\b/, /\bbacklog\b/,
    /\bcompan(y|ies)\b.*\b(eligib|criteria|require|cutoff)\b/,
    /\b(eligib|criteria|require|cutoff)\b.*\bcompan(y|ies)\b/,
    /\btier\s*[1-5]\b.*\bcompan/,
    /\b(tcs|infosys|wipro|cognizant|google|amazon|microsoft|zoho|flipkart|accenture|capgemini)\b.*\b(eligib|criteria|cutoff|cgpa|percent)\b/,
    /\b(eligib|criteria|cutoff|cgpa|percent)\b.*\b(tcs|infosys|wipro|cognizant|google|amazon|microsoft|zoho|flipkart|accenture|capgemini)\b/,
    /which compan(y|ies) (can i|am i|i can)/,
    /\bcan i (get into|apply|join)\b/,
  ];
  if (placementPatterns.some(p => p.test(lower))) return "db";

  const personalPatterns = [
    /\bwho am i\b/i,
    /\bwho i am\b/i,
    /\bmy\s*(?:profile|details|info)\b/i,
    /\bwhat is my\b/i,
    /\babout myself\b/i,
  ];
  if (personalPatterns.some(p => p.test(lower))) return "db";

  const advicePatterns = [
    /\bhow to improve\b/, /\bhow can (they|we|i|he|she) improve\b/,
    /\brecommend(ation)?s?\b/, /\bsuggestion?s?\b/, /\btips?\b/,
    /\badvice\b/, /\bwhat should (they|we|i|he|she)\b/,
    /\bhow (to|can) (learn|study|practice|prepare|get better)\b/,
    /\bstrateg(y|ies)\b/, /\bhelp them\b/, /\bguide\b/,
    /\bbest (way|practice|approach|method) to\b/,
  ];
  if (advicePatterns.some(p => p.test(lower))) {
    const platformTerms = /student|college|batch|enrolled|score|course|result|skcet|srec|mcet|kits|skct|skcet|niet|kclas|ciet/i;
    if (!platformTerms.test(lower)) return "general";
  }

  const generalKnowledge = [
    /^what (is|are|was|were)\s+.+/i,
    /^(explain|define|describe|tell me about)\s+/i,
    /^how does\s+.+\s+work/i,
    /^(what|who) (invented|created|discovered)\s+/i,
    /difference between/i,
    /^(what are (the )?benefits|advantages|disadvantages)/i,
  ];
  const platformTerms = /student|college|batch|enrolled|score|course|result|skcet|srec|allocated|my\s|department|mcet|kits|skct|niet|kclas|ciet/i;

  if (generalKnowledge.some(p => p.test(lower)) && !platformTerms.test(lower)) {
    return "general";
  }

  const dbPatterns = [
    /\bhow many\b/, /\bcount\b/, /\btotal\b/, /\baverage\b/, /\bsum\b/,
    /\bbest\b/, /\btop\b/, /\bworst\b/, /\branked?\b/, /\btopper\b/,
    /\bcompare\b/, /\bvs\b/, /\bversus\b/,
    /\bstudent\b/, /\bcollege\b/, /\bcourse\b/, /\bbatch\b/, /\bstaff\b/,
    /\btrainer\b/, /\badmin\b/, /\benroll(ed|ment)?\b/,
    /\blist\b/, /\bshow\b/, /\bgive me\b/, /\bwho\b/, /\bwhich\b/,
    /\bfind\b/, /\bget\b/,
    /\bscore\b/, /\bperform(ance|er)?\b/, /\bprogress\b/, /\bresult\b/,
    /\brank\b/, /\battend(ance)?\b/, /\bsubmission\b/,
    /\bsrec\b/, /\bskcet\b/, /\bkits\b/, /\bmcet\b/, /\bdotlab\b/,
    /\bpython\b|\bjava\b|\bc\+\+\b|\bsql\b|\bdata science\b/,
    /\boverview\b/, /\bdashboard\b/, /\bsummary\b/, /\bstatistic/,
    /\bdatabase\b/, /\bdb\b/,
    /\bplatform\b/, /\bnumbers\b/, /\blanguage\b/,
  ];
  if (dbPatterns.some(p => p.test(lower))) return "db";

  return "db";
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// LLM LAYER — Only for insights and general knowledge. NEVER for numbers.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const GENERAL_KNOWLEDGE_PROMPT = `You are Devora AI Assistant  and online coding education platform. Always here to help.
The user has asked a general knowledge or conceptual question (not a data query).
Answer clearly and thoroughly in Markdown format.
- Use ## heading to title your response
- Provide a clear explanation with examples where relevant
- For programming topics, include a short code example in a fenced code block
- Add practical context for how it applies to software development
- End with 1-2 sentences on real-world relevance
Keep it educational and engaging. This is NOT a database question — do not try to query anything.`;



function getGreeting(userName: string, roleName: string, collegeName: string | null): string {
  // ── Student (role=7) ──
  if (roleName === "Student") {
    return `## 🤖 Devora AI Assistant
**Hello ${userName}!** Welcome back.

### 💡 Try asking me:
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
    return `## 🤖 Devora AI Assistant
**Hello ${userName}!** Welcome back.

### 💡 Try asking me:
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
    return `## 🤖 Devora AI Assistant
**Hello ${userName}!** Welcome back.

### 💡 Try asking me:
${collegeName
        ? `- *"${collegeName} performance overview"*\n- *"Top students in ${collegeName}"*\n- *"Compare departments in ${collegeName}"*`
        : `- *"College performance overview"*\n- *"Top students"*`}
- *"How many students are enrolled?"*
- *"Course completion rates"*
- *"Students at risk"*

What would you like to explore?`;
  }

  // ── Admin/SuperAdmin (role=1,2) ──
  return `## 🤖 Devora AI Assistant
**Hello ${userName}!** Welcome back.

### 📊 Smart Insights I Can Provide:
- ðŸ† *"Compare all colleges"*
- ðŸ” *"Top 10 students platform-wide"*
- 📈 *"How many students across all colleges?"*
- 🎓 *"Which course has the highest enrollment?"*
- ðŸ« *"SKCET vs SREC vs MCET comparison"*
- 👤 *"Find student karthick"*

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
  const roleName = getRoleName(roleNum);
  const isStudentRole = roleNum === ROLES.STUDENT;
  const classification = classifyQuestionScope(question);
  const scope = classification.scope;

  let followUpContext = "";
  if (history && history.length > 0) {
    const contextExchanges = history.slice(-4);
    followUpContext = `
PREVIOUS CONVERSATION CONTEXT:
${contextExchanges.map(h => `${h.role === 'user' ? 'Question' : 'Answer'}: ${h.content}`).join('\n')}

The user is likely asking a FOLLOW-UP question.
Reuse the relevant tables/filters from the previous queries above to answer this.`;
  }

  const systemPrompt = `You are Devora AI — expert SQL analyst for coderv4 database (TiDB/MySQL).
User: id=${userId}, role=${roleNum} (${roleName})

${scopePrompt}

${followUpContext}

${cachedSchemaPrompt}

QUERY SHORTCUTS:
- "coding solved/scores" → course_wise_segregations WHERE type = 1
- "MCQ scores/accuracy" → course_wise_segregations WHERE type = 2
- "enrolled courses" → course_wise_segregations or user_course_enrollments WHERE user_id = X
- "allocated courses" → COUNT from course_academic_maps (NOT courses table)
- "available courses" → courses WHERE status = 1
- "student count" → users WHERE role = 7 AND status = 1
- "trainer count" → users WHERE role = 5 AND status = 1
- "my trainer" → course_wise_segregations → course_academic_maps → course_staff_trainer_allocations

RULES:
1. You already have the full schema above — go DIRECTLY to run_sql. Only use list_tables/describe_table for tables NOT in the schema.
2. Only SELECT queries allowed
3. Always filter status = 1 for active records
4. Format answer as markdown with tables where appropriate
5. Be efficient — most queries need only 1-2 run_sql calls
6. Present data clearly with counts, percentages, and comparisons
7. For JOINs: users → user_academics (user_id) → colleges (college_id) → departments (department_id)`;

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
          const cleaned = query.trim().replace(/^```(sql)?\s*/i, "").replace(/\s*```$/i, "").trim();

          if (!cleaned.toLowerCase().startsWith("select")) {
            return { error: "Only SELECT queries allowed" };
          }

          // Security: student personal queries MUST include user_id
          if (isStudentRole && scope === "personal" && !cleaned.includes(String(userId))) {
            return { error: `Security: Personal queries must filter by user_id = ${userId}` };
          }

          const res = await databaseConnectionService.executeQuery(
            dbMock, cleaned, { databaseName: dbName }
          );
          if (!res.success) return { error: res.error, sql: cleaned };
          if (!res.data?.length) return { warning: "0 rows returned. Check your query.", sql: cleaned, rows: [] };
          return { rows: res.data.slice(0, 200), total: res.data.length, sql: cleaned };
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
    stopWhen: stepCountIs(12),
    temperature: 0,
  });

  for (const step of result.steps ?? []) {
    for (const tr of (step.toolResults ?? []) as any[]) {
      const raw = tr.result ?? tr.output;
      if (tr.toolName === "run_sql" && raw?.sql) {
        executedSql += raw.sql + ";\n";
      }
    }
  }

  return {
    report: result.text?.trim() || "Could not generate response.",
    sql: executedSql || null,
    steps: result.steps?.length ?? 1,
  };
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MAIN HANDLER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function handleDbQuestion(
  question: string,
  userId: string,
  userRole: string | number | undefined,
  history: any[],
  consoleId: string | undefined,
  options: { version: 'v1' | 'v2' }
) {
  const roleNum = Number(userRole) || 0;
  const reasonerModel = makeDeepSeekModel("deepseek-reasoner");
  const route = preRouteQuestion(question.trim());

  logger.info(`Agent chat (${options.version})`, { userId, role: roleNum, route, question: question.slice(0, 80) });

  // ── GREETING (instant, personalized) ──
  if (route === "greeting") {
    const profile = await getUserProfile(Number(userId));
    const roleName = getRoleName(roleNum);
    return { report: getGreeting(profile?.name || "there", roleName, profile?.college_name || null), sql: null, steps: 0 };
  }

  // ── GENERAL KNOWLEDGE (no DB) ──
  if (route === "general") {
    try {
      const result = await generateText({
        model: reasonerModel,
        system: GENERAL_KNOWLEDGE_PROMPT,
        messages: [...(history as any), { role: "user" as const, content: question.trim() }],
        temperature: 0.4,
      });
      return { report: result.text?.trim() || "I couldn't generate an answer.", sql: null, steps: 1 };
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

    // STEP 1: Classify the question
    const classification = classifyQuestionScope(question);
    const scope = classification.scope;
    logger.info(`Question classified (${options.version})`, { userId, role: roleNum, scope, reason: classification.reason });

    // STEP 2: IDENTITY fast-path (reason === 'identity' within personal scope) — instant profile, no LLM needed
    if (classification.reason === "identity") {
      const profile = await getUserProfile(numUserId);
      if (!profile) return { report: "Could not find your profile.", sql: null, steps: 1 };
      const roleName = getRoleName(profile.role);
      const report = `### User Profile\n\n| Field | Value |\n|-------|-------|\n| Name | ${profile.name} |\n| Email | ${profile.email} |\n| Role | ${roleName} |\n| Roll No | ${profile.roll_no || 'N/A'} |\n| College | ${profile.college_name || 'N/A'} |\n| Department | ${profile.department_name || 'N/A'} |\n| Batch | ${profile.batch_name || 'N/A'} |\n`;
      logger.info(`Agent chat complete — identity fast-path (${options.version})`, { userId, totalTimeMs: Date.now() - t0 });
      return { report, sql: null, steps: 1 };
    }

    // STEP 3: Build scope prompt for LLM
    const profile = await getUserProfile(numUserId);
    const collegeId = profile?.college_id || null;
    const scopeResult = buildScopePrompt(roleNum, numUserId, collegeId, scope, profile?.name);

    // STEP 4: Check if blocked (student asking restricted questions)
    if (scopeResult.blocked) {
      logger.info(`Agent chat complete — blocked (${options.version})`, { userId, role: roleNum, scope });
      return { report: scopeResult.blockReason || "Access denied.", sql: null, steps: 1 };
    }

    // STEP 5: LLM with tools — the brain does the work
    logger.info(`LLM with tools (${options.version})`, { userId, role: roleNum, scope });
    const result = await handleWithTools(question, numUserId, roleNum, history, options, scopeResult.prompt);
    const totalTime = Date.now() - t0;
    logger.info(`Agent chat complete (${options.version})`, { userId, role: roleNum, totalTimeMs: totalTime, steps: result.steps });
    return result;

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
