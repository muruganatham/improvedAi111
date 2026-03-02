import { tool } from "ai";

import { z } from "zod";
import mongoose from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import type { ConsoleDataV2 } from "../types";
import { clientConsoleTools } from "./console-tools-client";
import {
  truncateSamples,
  truncateQueryResults,
  MAX_SAMPLE_ROWS,
} from "./shared/truncation";
import {
  escapeMySqlIdentifier,
  ensureValidObjectId,
} from "./shared/sql-dialects";
import { MYSQL_SYSTEM_DATABASES_SET } from "../../databases/drivers/mysql/driver";

// LIMIT enforcement
const needsDefaultLimit = (sql: string): boolean => {
  const trimmed = sql.trim();
  if (!trimmed) return false;

  const normalized = trimmed
    .replace(/(--.*?$)/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  if (!normalized) return false;

  const firstTokenMatch = normalized.match(/^[\s(]*([a-z]+)/i);
  if (!firstTokenMatch) return false;

  const firstToken = firstTokenMatch[1].toLowerCase();
  return firstToken === "select" || firstToken === "with";
};

const appendLimitIfMissing = (sql: string): string => {
  if (!needsDefaultLimit(sql)) return sql;
  if (/\blimit\s+\d+/i.test(sql)) return sql;

  const trimmed = sql.trim().replace(/;\s*$/i, "");
  return `${trimmed}\nLIMIT 500;`;
};

// Fetch and validate database connection
const fetchSqlDatabase = async (connectionId: string, workspaceId: string) => {
  // Direct Mode Bypass
  if (process.env.BYPASS_AUTH === "true" || mongoose.connection.readyState !== 1) {
    return {
      _id: connectionId as any,
      workspaceId: workspaceId as any,
      type: "mysql",
      name: "TiDB (Direct)",
      connection: {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === "true",
      }
    };
  }

  const connectionObjectId = ensureValidObjectId(connectionId, "connectionId");
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const database = await DatabaseConnection.findOne({
    _id: connectionObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!database) {
    throw new Error("Database connection not found or access denied");
  }

  if (database.type !== "mysql") {
    throw new Error(`This tool only supports TiDB (MySQL driver). Got: ${database.type}`);
  }

  return database;
};

// Zod schemas
const emptySchema = z.object({
  confirm: z.boolean().describe("Required confirmation"),
});
const connectionIdSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
});
const connectionAndDbSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  database: z.string().describe("The database name"),
});
const inspectTableSchema = z.object({
  connectionId: z.string().describe("The connection ID"),
  database: z.string().describe("The database name"),
  table: z.string().describe("The table name"),
});
const executeQuerySchema = z.object({
  connectionId: z.string().optional().describe("The connection ID"),
  database: z.string().optional().describe("The database name (default: coderv4)"),
  query: z.string().optional().describe("The SQL query to execute"),
});

// Implementation functions
async function listDatabasesImpl(connectionId: string, workspaceId: string) {
  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    "SHOW DATABASES",
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list databases");
  }

  return (result.data || [])
    .map((row: any) => row.Database || row.database)
    .filter((name: string) => !!name && !MYSQL_SYSTEM_DATABASES_SET.has(name))
    .map((name: string) => ({ name, sqlDialect: "mysql" }));
}

async function listTablesImpl(connectionId: string, databaseName: string, workspaceId: string) {
  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const safeDb = databaseName.replace(/'/g, "''");
  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT table_name AS table_name, table_type AS table_type
     FROM information_schema.tables
     WHERE table_schema = '${safeDb}'
     ORDER BY table_name;`,
    { databaseName },
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to list tables");
  }

  return (result.data || []).map((row: any) => ({
    name: row.table_name ?? row.TABLE_NAME,
    type: (row.table_type ?? row.TABLE_TYPE) === "VIEW" ? "view" : "table",
    sqlDialect: "mysql",
  }));
}

async function inspectTableImpl(connectionId: string, databaseName: string, tableName: string, workspaceId: string) {
  const database = await fetchSqlDatabase(connectionId, workspaceId);
  const safeDb = databaseName.replace(/'/g, "''");
  const safeTable = tableName.replace(/'/g, "''");

  const columnsResult = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT column_name AS column_name, data_type AS data_type, is_nullable AS is_nullable, column_default AS column_default
     FROM information_schema.columns
     WHERE table_schema = '${safeDb}'
       AND table_name = '${safeTable}'
     ORDER BY ordinal_position;`,
    { databaseName },
  );

  if (!columnsResult.success) {
    throw new Error(columnsResult.error || "Failed to get columns");
  }

  const columns = (columnsResult.data || []).map((row: any) => ({
    name: row.column_name ?? row.COLUMN_NAME,
    types: [row.data_type ?? row.DATA_TYPE],
    nullable: (row.is_nullable ?? row.IS_NULLABLE)?.toUpperCase() === "YES",
    defaultValue: row.column_default ?? row.COLUMN_DEFAULT,
  }));

  const qualifiedName = `${escapeMySqlIdentifier(databaseName)}.${escapeMySqlIdentifier(tableName)}`;
  const samplesResult = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    `SELECT * FROM ${qualifiedName} LIMIT ${MAX_SAMPLE_ROWS};`,
    { databaseName },
  );

  const samples = samplesResult.success && samplesResult.data ? samplesResult.data : [];
  const { samples: truncatedSamples, _note } = truncateSamples(samples, MAX_SAMPLE_ROWS);

  return {
    sqlDialect: "mysql",
    entityKind: "table",
    entityName: tableName,
    database: databaseName,
    fields: columns,
    samples: truncatedSamples,
    _note,
  };
}

async function executeQueryImpl(connectionId?: string, databaseName?: string, query?: string, workspaceId?: string) {
  if (!connectionId || !query) {
    return { success: false, error: "Missing connectionId or query. You must call list_connections first to get a connection ID, and then provide a SQL query." };
  }
  const database = await fetchSqlDatabase(connectionId, workspaceId!);
  const finalQuery = appendLimitIfMissing(query);

  const result = await databaseConnectionService.executeQuery(
    database as Parameters<typeof databaseConnectionService.executeQuery>[0],
    finalQuery,
    { databaseName: databaseName || process.env.DB_NAME },
  );

  if (result.success && result.data) {
    return { ...result, data: truncateQueryResults(result.data) };
  }
  return result;
}

export const createSqlToolsV2 = (workspaceId: string, _consoles: ConsoleDataV2[], _preferredConsoleId?: string) => {
  return {
    sql_list_databases: tool({
      description: "List available databases on the TiDB server.",
      parameters: connectionIdSchema,
      execute: async (params: z.infer<typeof connectionIdSchema>) => listDatabasesImpl(params.connectionId, workspaceId),
    } as any),
    sql_list_tables: tool({
      description: "List tables in a TiDB database.",
      parameters: connectionAndDbSchema,
      execute: async (params: z.infer<typeof connectionAndDbSchema>) => listTablesImpl(params.connectionId, params.database, workspaceId),
    } as any),
    sql_inspect_table: tool({
      description: "Get table schema and sample rows for a TiDB table.",
      parameters: inspectTableSchema,
      execute: async (params: z.infer<typeof inspectTableSchema>) => inspectTableImpl(params.connectionId, params.database, params.table, workspaceId),
    } as any),
    sql_execute_query: tool({
      description: "Execute a MySQL/TiDB query and return results.",
      parameters: executeQuerySchema,
      execute: async (params: z.infer<typeof executeQuerySchema>) => executeQueryImpl(params.connectionId, params.database, params.query, workspaceId),
    } as any),
  };
};
