
import { databaseConnectionService } from "../../../services/database-connection.service";

const STOP_WORDS = new Set([
    "who", "is", "the", "best", "in", "how", "many", "are", "there",
    "what", "where", "my", "me", "i", "am", "a", "an", "of", "for",
    "with", "to", "give", "show", "get", "list", "find", "does", "do",
    "has", "have", "that", "this", "was", "will", "can", "could",
]);

// Typo / alias normalization — map common misspellings to canonical form
const TYPO_MAP: Record<string, string> = {
    "entrolled": "enroll",
    "entrollment": "enroll",
    "enrollment": "enroll",
    "enrolled": "enroll",
    "enrolment": "enroll",
    "enroll": "enroll",
    "registerd": "register",
    "registerred": "register",
    "courese": "course",
    "cource": "course",
};

// Semantic keyword expansion — maps question concepts to DB table name fragments
const SEMANTIC_HINTS: Record<string, string[]> = {
    "best": ["result", "score", "segregation", "rank", "performance"],
    "performer": ["result", "score", "segregation", "rank", "performance"],
    "ranking": ["result", "score", "segregation", "rank"],
    "student": ["user", "academic", "roll"],
    "students": ["user", "academic", "roll"],
    "identity": ["user", "personal", "profile"],
    "enroll": ["course", "enroll", "register", "subscription", "join"],
    "course": ["course", "enroll", "subject", "class", "module"],
    "courses": ["course", "enroll", "subject", "class"],
    "register": ["enroll", "register", "course"],
    "mark": ["result", "score", "mark", "grade"],
    "marks": ["result", "score", "mark", "grade"],
    "grade": ["result", "score", "grade"],
    "attend": ["attendance", "attend"],
    "attendance": ["attendance", "attend"],
    "fee": ["fee", "payment", "transaction"],
    "payment": ["fee", "payment", "transaction"],
    "admin": ["admin", "role", "user"],
    "batch": ["batch", "group", "section"],
    "exam": ["exam", "test", "question", "quiz"],
    "test": ["test", "exam", "question"],
    "quiz": ["quiz", "question", "exam"],
};

/**
 * Dynamically discover relevant table schemas based on the user's question.
 * Falls back to loading ALL table names if keyword search returns nothing.
 */
export async function discoverRelevantSchema(question: string, databaseName: string): Promise<string> {
    const db = { id: "000000000000000000000002", type: "mysql" };

    const rawKeywords = question.toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .split(" ")
        .filter(k => k.length > 2 && !STOP_WORDS.has(k))
        .map(k => TYPO_MAP[k] || k); // Normalize typos

    // Expand keywords with semantic synonyms
    const keywords = [...new Set([
        ...rawKeywords,
        ...rawKeywords.flatMap(k => SEMANTIC_HINTS[k] || []),
    ])];

    let tableNames: string[] = [];

    if (keywords.length > 0) {
        // 1. Find tables that match keywords
        const tableClauses = keywords.map(k => `table_name LIKE '%${k}%'`).join(" OR ");
        const tableQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = '${databaseName}'
      AND (${tableClauses})
      LIMIT 15;
    `;

        const tablesResult = await databaseConnectionService.executeQuery(db as any, tableQuery, { databaseName });

        if (tablesResult.success && tablesResult.data && tablesResult.data.length > 0) {
            tableNames = tablesResult.data.map((r: any) => r.table_name);
        }
    }

    // 2. FALLBACK: If no tables matched, load ALL table names so AI can reason about which to query
    if (tableNames.length === 0) {
        const allTablesQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = '${databaseName}'
      ORDER BY table_name
      LIMIT 60;
    `;
        const allTablesResult = await databaseConnectionService.executeQuery(db as any, allTablesQuery, { databaseName });
        if (allTablesResult.success && allTablesResult.data) {
            tableNames = allTablesResult.data.map((r: any) => r.table_name);
        }

        if (tableNames.length === 0) return "";

        // When falling back, just return the table list (no columns) to keep prompt small
        const tableList = tableNames.join(", ");
        return `\n\n### ⚠️ No exact table match found for your keywords. All available tables in \`${databaseName}\`:\n\`${tableList}\`\n\nUse these exact table names in your SQL query.\n`;
    }

    // 3. Fetch columns for matched tables
    const columnClauses = tableNames.map((t: string) => `'${t}'`).join(",");
    const columnQuery = `
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = '${databaseName}'
    AND table_name IN (${columnClauses})
    ORDER BY table_name, ordinal_position;
  `;

    const colsResult = await databaseConnectionService.executeQuery(db as any, columnQuery, { databaseName });
    if (!colsResult.success || !colsResult.data) return "";

    // 4. Build Markdown Schema Context
    let context = "\n\n### 🔍 Relevant Tables (use ONLY these exact table names):\n";
    const tablesMap = new Map<string, string[]>();

    colsResult.data.forEach((c: any) => {
        if (!tablesMap.has(c.table_name)) tablesMap.set(c.table_name, []);
        tablesMap.get(c.table_name)?.push(`${c.column_name} (${c.data_type})`);
    });

    tablesMap.forEach((cols, tableName) => {
        context += `- **${tableName}**: ${cols.join(", ")}\n`;
    });

    context += "\n> ⚠️ IMPORTANT: Use ONLY the exact table names listed above. Do NOT guess or invent table names.\n";

    return context;
}
