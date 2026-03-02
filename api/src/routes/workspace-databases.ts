/**
 * workspace-databases.ts — TiDB Direct Mode
 *
 * All auth middleware (user, workspace, apiKey variables) has been removed.
 * Every route runs in Direct Mode: BYPASS_AUTH=true, using .env credentials.
 * MongoDB paths are preserved but unreachable in this configuration.
 */

import { Hono } from "hono";
import {
  IDatabaseConnection,
} from "../database/workspace-schema";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  queryExecutionService,
  QueryLanguage,
  QuerySource,
  QueryStatus,
} from "../services/query-execution.service";
import { Types } from "mongoose";
import { loggers } from "../logging";

const logger = loggers.db();

function getQueryLanguage(_databaseType: string): QueryLanguage {
  return "sql";
}

// Direct Mode TiDB connection stub
const DIRECT_TIDB_ID = "000000000000000000000002";

function directTidbConnection(): IDatabaseConnection {
  return {
    _id: new Types.ObjectId(DIRECT_TIDB_ID),
    type: "mysql",
    name: "TiDB (Direct Connection)",
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 4000),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === "true",
    },
  } as any;
}

export const workspaceDatabaseRoutes = new Hono();

// GET /databases — list all connections (Direct Mode: TiDB only)
workspaceDatabaseRoutes.get("/", async (c) => {
  return c.json({
    success: true,
    data: [
      {
        id: DIRECT_TIDB_ID,
        connectionId: DIRECT_TIDB_ID,
        name: "TiDB (Direct Connection)",
        displayName: "TiDB (Direct Connection)",
        type: "mysql",
        active: true,
        database: process.env.DB_NAME,
        hostKey: process.env.DB_HOST,
        hostName: "TiDB Cloud",
        isDemo: false,
        isClusterMode: false,
      },
    ],
  });
});

// POST /databases/demo — create demo DB (stub)
workspaceDatabaseRoutes.post("/demo", async (c) => {
  return c.json({
    success: true,
    data: { id: DIRECT_TIDB_ID, name: "TiDB Direct", type: "mysql", isDemo: true },
    message: "Demo database (Direct Mode)",
  });
});

// POST /databases/test-connection — test a connection config
workspaceDatabaseRoutes.post("/test-connection", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.type) return c.json({ success: false, error: "Database type is required" }, 400);
    if (!body.connection) return c.json({ success: false, error: "Connection configuration is required" }, 400);
    const tempDatabase = {
      _id: new Types.ObjectId(),
      type: body.type,
      connection: body.connection,
    } as IDatabaseConnection;
    const result = await databaseConnectionService.testConnection(tempDatabase);
    return c.json(result);
  } catch (error) {
    logger.error("Error testing database connection", { error });
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed to test connection" }, 500);
  }
});

// POST /databases — create a DB connection (stub in Direct Mode)
workspaceDatabaseRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name || !body.type) {
      return c.json({ success: false, error: "Name and type are required" }, 400);
    }
    // In Direct Mode, test the connection and return stub response
    await databaseConnectionService.testConnection({
      _id: new Types.ObjectId(),
      type: body.type,
      connection: body.connection || {},
    } as any);
    return c.json(
      {
        success: true,
        data: { id: DIRECT_TIDB_ID, name: body.name, type: body.type, createdAt: new Date() },
        message: "Database created (Direct Mode — using .env credentials)",
      },
      201
    );
  } catch (error) {
    logger.error("Error creating database", { error });
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed to create database" }, 500);
  }
});

// GET /databases/:id — get specific DB
workspaceDatabaseRoutes.get("/:id", async (c) => {
  const databaseId = c.req.param("id");
  return c.json({
    success: true,
    data: {
      id: databaseId,
      connectionId: databaseId,
      name: "TiDB (Direct Connection)",
      displayName: "TiDB (Direct Connection)",
      type: "mysql",
      active: true,
      database: process.env.DB_NAME,
      databaseName: process.env.DB_NAME,
      hostKey: process.env.DB_HOST,
      hostName: "TiDB Cloud",
      isDemo: false,
      isClusterMode: false,
      connection: {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 4000),
        username: process.env.DB_USER,
        database: process.env.DB_NAME,
        ssl: process.env.DB_SSL === "true",
      },
    },
  });
});

// PUT /databases/:id — update (stub)
workspaceDatabaseRoutes.put("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ success: true, data: { ...body, updatedAt: new Date() }, message: "Database updated (Direct Mode stub)" });
});

// DELETE /databases/:id — delete (stub)
workspaceDatabaseRoutes.delete("/:id", async (c) => {
  return c.json({ success: true, message: "Database deleted (Direct Mode stub)" });
});

// POST /databases/:id/test — test connection
workspaceDatabaseRoutes.post("/:id/test", async (c) => {
  try {
    const db = directTidbConnection();
    const result = await databaseConnectionService.testConnection(db);
    return c.json(result);
  } catch (error) {
    logger.error("Error testing connection", { error });
    return c.json({ success: false, error: error instanceof Error ? error.message : "Test failed" }, 500);
  }
});

// POST /databases/:id/execute — execute query
workspaceDatabaseRoutes.post("/:id/execute", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.query) return c.json({ success: false, error: "query is required" }, 400);
    const db = directTidbConnection();
    const result = await databaseConnectionService.executeQuery(db, body.query, body.options);
    return c.json(result);
  } catch (error) {
    logger.error("Error executing query", { error });
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed to execute query" }, 500);
  }
});

// GET /databases/:id/collections — TiDB has no mongo-style collections
workspaceDatabaseRoutes.get("/:id/collections", async (c) => {
  return c.json({ success: true, data: [] });
});

// GET /databases/:id/collections/:name
workspaceDatabaseRoutes.get("/:id/collections/:name", async (c) => {
  return c.json({ success: false, error: "Collections endpoint is for MongoDB only" }, 400);
});

// GET /databases/:id/views
workspaceDatabaseRoutes.get("/:id/views", async (c) => {
  return c.json({ success: true, data: [] });
});

// ============================================================================
// Workspace-level execute endpoint
// Mounted at /api/workspaces/:workspaceId/execute in index.ts
// ============================================================================
export const workspaceExecuteRoutes = new Hono();

workspaceExecuteRoutes.post("/", async (c) => {
  const startTime = Date.now();
  let executionStatus: QueryStatus = "error";
  let rowCount: number | undefined;
  let errorType: string | undefined;
  let database: IDatabaseConnection | null = null;

  try {
    const body = await c.req.json();
    const { connectionId, databaseName, query, executionId, consoleId, source } = body;

    if (!connectionId) return c.json({ success: false, error: "connectionId is required" }, 400);
    if (!query) return c.json({ success: false, error: "query is required" }, 400);

    // Use Direct Mode TiDB connection
    database = directTidbConnection();

    const options = { databaseId: connectionId, databaseName, executionId };
    const result = await databaseConnectionService.executeQuery(database, query, options);

    if (result.success) {
      executionStatus = "success";
      rowCount = result.rowCount ?? (Array.isArray(result.data) ? result.data.length : undefined);
    } else {
      executionStatus = "error";
      const msg = result.error?.toLowerCase() || "";
      if (msg.includes("syntax")) errorType = "syntax";
      else if (msg.includes("timeout") || msg.includes("timed out")) { errorType = "timeout"; executionStatus = "timeout"; }
      else if (msg.includes("cancel") || msg.includes("abort")) { errorType = "cancelled"; executionStatus = "cancelled"; }
      else if (msg.includes("connection") || msg.includes("connect")) errorType = "connection";
      else if (msg.includes("permission") || msg.includes("access denied")) errorType = "permission";
      else errorType = "unknown";
    }

    // Fire-and-forget tracking
    const executionSource: QuerySource = (source as QuerySource) || "console_ui";
    const queryLang: QueryLanguage = getQueryLanguage(database.type);
    const validConsoleId = consoleId && Types.ObjectId.isValid(consoleId) ? new Types.ObjectId(consoleId) : undefined;

    queryExecutionService.track({
      userId: "direct-mode",
      workspaceId: new Types.ObjectId("000000000000000000000001") as any,
      connectionId: database._id,
      databaseName: databaseName || process.env.DB_NAME || "",
      consoleId: validConsoleId,
      source: executionSource,
      databaseType: database.type,
      queryLanguage: queryLang,
      status: executionStatus,
      executionTimeMs: Date.now() - startTime,
      rowCount,
      errorType,
    });

    return c.json(result);
  } catch (error) {
    logger.error("Error executing query", { error });
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed to execute query" }, 500);
  }
});

workspaceExecuteRoutes.post("/cancel", async (c) => {
  return c.json({ success: true, message: "Query cancellation not supported in TiDB Direct Mode" });
});
