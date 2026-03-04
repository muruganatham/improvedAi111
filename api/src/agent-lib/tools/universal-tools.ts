
import { z } from "zod";
import { tool } from "ai";
import mongoose, { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import type { ConsoleDataV2 } from "../types";
import {
  clientConsoleTools,
  listOpenConsolesSchema,
  modifyConsoleSchema, // eslint-disable-line @typescript-eslint/no-unused-vars
  readConsoleSchema, // eslint-disable-line @typescript-eslint/no-unused-vars
  setConsoleConnectionSchema, // eslint-disable-line @typescript-eslint/no-unused-vars
} from "./console-tools-client";
import { createSqlToolsV2 } from "./sql-tools";


// DeepSeek requires JSON schema to have properties and not be empty nulls
// and AI SDK Core may strip them if not used in execute arguments.
const emptySchema = z.object({
  _dummy: z.string().optional().describe("Ignore this field"),
});



// Specialized for TiDB (MySQL driver)
const SUPPORTED_CONNECTION_TYPES = new Set([
  "mysql",
]);

async function listAllConnectionsImpl(_workspaceId: string) {
  // Direct Mode Bypass — skip ObjectId validation entirely
  if (process.env.BYPASS_AUTH === "true" || mongoose.connection.readyState !== 1) {
    return [{
      id: "000000000000000000000002",
      name: "TiDB (coderv4)",
      type: "mysql",
      displayName: "TiDB (coderv4)",
      databaseName: process.env.DB_NAME,
      host: process.env.DB_HOST,
      active: true,
    }];
  }

  if (!Types.ObjectId.isValid(_workspaceId)) {
    throw new Error("Invalid workspace ID");
  }

  const databases = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(_workspaceId),
    type: { $in: Array.from(SUPPORTED_CONNECTION_TYPES) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: Record<string, unknown> =
      (db as unknown as { connection: Record<string, unknown> }).connection ||
      {};

    const host = (connection.host || connection.instanceConnectionName) as
      | string
      | undefined;
    const databaseName = (connection.database || connection.db) as
      | string
      | undefined;
    const displayInfo = `${host || "unknown-host"}/${databaseName || "unknown-db"}`;

    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      sqlDialect: "mysql",
      host,
      databaseName,
      displayName: `${db.name} (tidb: ${displayInfo})`,
      active: true,
    };
  });
}

/**
 * Create a specialized toolset for the TiDB agent.
 */
export const createUniversalTools = (
  workspaceId: string,
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
  _userId?: string,
) => {
  // Get SQL tools (now specialized for MySQL/TiDB)
  const sqlTools = createSqlToolsV2(workspaceId, consoles, preferredConsoleId);

  return {
    // Discovery Tools
    list_connections: tool({
      description:
        "List all TiDB database connections in this workspace. Use this to discover available databases before running queries.",
      parameters: emptySchema,
      execute: async (_params: { _dummy?: string }) => {
        return listAllConnectionsImpl(workspaceId);
      },
    } as any),

    // Console Tools (excluding the discovery discovery one which is overridden below)
    read_console: clientConsoleTools.read_console,
    modify_console: clientConsoleTools.modify_console,
    create_console: clientConsoleTools.create_console,
    set_console_connection: clientConsoleTools.set_console_connection,

    // Server-side override for discovery (prevents client-side stop)
    list_open_consoles: tool({
      description:
        "List all open console tabs in the UI. Returns each console's id, title, connectionId, databaseName, content preview, and isActive flag. Use this to get console IDs if they are not already provided in your system prompt.",
      parameters: listOpenConsolesSchema,
      execute: async (_params: Record<string, unknown>) => {
        return (consoles || []).map(c => ({
          ...c,
          isActive: c.id === preferredConsoleId,
        })) as any;
      },
    } as any),

    // SQL tools (sql_list_databases, sql_list_tables, sql_inspect_table, sql_execute_query)
    ...sqlTools,
  };
};

/**
 * SQL-only tools — no UI console tools.
 * Use this for direct question→SQL→report flows where there is no browser UI.
 * Removes create_console, modify_console, read_console, set_console_connection, list_open_consoles
 * so the AI cannot try to build a UI and will go straight to running SQL.
 */
export const createSqlOnlyTools = (workspaceId: string) => {
  const sqlTools = createSqlToolsV2(workspaceId, [], undefined);

  return {
    list_connections: tool({
      description:
        "List available TiDB database connections. Call this first to get the connection ID needed for SQL queries.",
      parameters: emptySchema,
      execute: async (_params: { _dummy?: string }) => {
        return listAllConnectionsImpl(workspaceId);
      },
    } as any),
    ...sqlTools,
  };
};

