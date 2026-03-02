/**
 * Schema Cache Service — MakoAI-style full schema pre-load
 *
 * Loads ALL tables + columns from TiDB at startup and caches them.
 * Injected into every agent system prompt so the AI ALWAYS knows the exact schema.
 * Refreshes every 30 minutes in the background.
 */

import { databaseConnectionService } from "../../../services/database-connection.service";

const DB_ID = { id: "000000000000000000000002", type: "mysql" } as any;
const DB_NAME = process.env.DB_NAME || "coderv4";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let cachedSchemaPrompt: string = "";
let lastRefresh: number = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Load the full schema from TiDB and build a compact markdown prompt section.
 */
async function loadFullSchema(): Promise<string> {
    try {
        // Get all tables
        const tablesResult = await databaseConnectionService.executeQuery(
            DB_ID,
            `SELECT table_name, table_comment
       FROM information_schema.tables
       WHERE table_schema = '${DB_NAME}'
       ORDER BY table_name;`,
            { databaseName: DB_NAME },
        );

        if (!tablesResult.success || !tablesResult.data || tablesResult.data.length === 0) {
            return "";
        }

        const tableNames: string[] = tablesResult.data.map((r: any) => r.table_name as string);

        // Get ALL columns for the database in one efficient query (no IN clause needed)
        const colsResult = await databaseConnectionService.executeQuery(
            DB_ID,
            `SELECT table_name, column_name, data_type, column_key
       FROM information_schema.columns
       WHERE table_schema = '${DB_NAME}'
       ORDER BY table_name, ordinal_position;`,
            { databaseName: DB_NAME },
        );

        if (!colsResult.success || !colsResult.data) return "";

        // Group columns by table
        const tableMap = new Map<string, string[]>();
        for (const col of colsResult.data as any[]) {
            if (!tableMap.has(col.table_name)) tableMap.set(col.table_name, []);
            const key = col.column_key === "PRI" ? `**${col.column_name}**` : col.column_name;
            tableMap.get(col.table_name)!.push(`${key}:${col.data_type}`);
        }

        // Build compact schema block
        let schema = `\n\n### DATABASE SCHEMA — \`${DB_NAME}\` (${tableNames.length} tables)\n`;
        schema += `> Use ONLY these exact table names. Never invent tables. Bold = Primary Key.\n\n`;

        tableMap.forEach((cols, tableName) => {
            schema += `**${tableName}**: ${cols.join(", ")}\n`;
        });

        return schema;
    } catch (err) {
        console.error("[schema-cache] Failed to load schema:", err);
        return "";
    }
}

/**
 * Initialize the schema cache. Call once at application startup.
 */
export async function initSchemaCache(): Promise<void> {
    cachedSchemaPrompt = await loadFullSchema();
    lastRefresh = Date.now();

    const tableCount = (cachedSchemaPrompt.match(/^\*\*/gm) || []).length;
    console.log(`[schema-cache] Loaded ${tableCount} tables from ${DB_NAME}`);

    // Set up periodic refresh
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
        const fresh = await loadFullSchema();
        if (fresh) {
            cachedSchemaPrompt = fresh;
            lastRefresh = Date.now();
            console.log(`[schema-cache] Schema refreshed at ${new Date().toISOString()}`);
        }
    }, REFRESH_INTERVAL_MS);
}

/**
 * Get the full schema as a prompt string (for injection into system prompts).
 * Returns cached version; triggers a refresh if cache is empty.
 */
export async function getFullSchemaPrompt(): Promise<string> {
    if (!cachedSchemaPrompt) {
        cachedSchemaPrompt = await loadFullSchema();
        lastRefresh = Date.now();
    }
    return cachedSchemaPrompt;
}

/**
 * Get cache status (for debugging).
 */
export function getSchemaCacheStatus() {
    return {
        cached: !!cachedSchemaPrompt,
        lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : "never",
        sizeBytes: cachedSchemaPrompt.length,
    };
}
