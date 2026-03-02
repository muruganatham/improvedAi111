// IMPORTANT: env.ts must be the very first import.
// It loads .env synchronously so that process.env is populated
// before any module-level code (including logging initialization) runs.
import "./env";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { serve as serveInngest } from "inngest/hono";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { consoleRoutes } from "./routes/consoles";
import { executeRoutes } from "./routes/execute";
import { databaseRoutes } from "./routes/database";
import { dataSourceRoutes } from "./routes/sources";
import { customPromptRoutes } from "./routes/custom-prompt";
import { chatsRoutes } from "./routes/chats";
import { agentRoutes } from "./routes/agent.routes";
// connectDatabase removed — TiDB Direct Mode, no MongoDB needed
import { workspaceRoutes } from "./routes/workspaces";
import {
  workspaceDatabaseRoutes,
  workspaceExecuteRoutes,
} from "./routes/workspace-databases";
import { connectorRoutes } from "./routes/connectors";
import { databaseSchemaRoutes } from "./routes/database-schemas";
import { databaseTreeRoutes } from "./routes/database-tree";
import { databaseRegistry } from "./databases/registry";
import { MySQLDatabaseDriver } from "./databases/drivers/mysql/driver";
import { functions, inngest, logInngestStatus } from "./inngest";

import { databaseConnectionService } from "./services/database-connection.service";
import { initSchemaCache } from "./agent-lib/tools/shared/schema-cache";
import { loggers, loggingMiddleware } from "./logging";
import { swaggerUI } from "@hono/swagger-ui";
import { openApiSpec } from "./openapi";

// Resolve the root‐level .env file regardless of the runtime working directory
const envPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// Logger - LogTape initialization starts automatically when the logging module
// is imported. By the time request handlers execute, initialization will be complete.
const logger = loggers.app();

const app = new Hono();

// CORS middleware
app.use(
  "*",
  cors({
    origin: process.env.CLIENT_URL || "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// Logging middleware - must be before other middleware to capture all requests
// Skip logging for noisy routes (Inngest polling, health checks) in development
app.use(
  "*",
  loggingMiddleware({
    skipSuccessInDev: ["/api/inngest", "/health"],
  }),
);

// Global JSON error handler – ensures errors are returned as JSON
app.onError((err, c) => {
  logger.error("Unhandled API error", {
    error: err,
    path: c.req.path,
    method: c.req.method,
  });
  const message = err instanceof Error ? err.message : "Internal Server Error";
  return c.json({ success: false, error: message }, 500);
});

// Not found handler for unknown routes
app.notFound(c => c.json({ success: false, error: "Not Found" }, 404));

// Health check
app.get("/health", c => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Welcome endpoint
app.get("/welcome", c => {
  return c.json({ message: "Welcome to the backend application!" });
});

// Favicon handler - silences 404 warnings in browser
app.get("/favicon.ico", c => c.body(null, 204));

// API routes
app.route("/api/workspaces", workspaceRoutes);
app.route("/api/workspaces/:workspaceId/databases", databaseTreeRoutes);
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);
app.route("/api/workspaces/:workspaceId/execute", workspaceExecuteRoutes);
app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);
app.route("/api/workspaces/:workspaceId/chats", chatsRoutes);
app.route("/api/workspaces/:workspaceId/custom-prompt", customPromptRoutes);
// Connectors routes
app.route("/api/workspaces/:workspaceId/connectors", dataSourceRoutes);

app.route("/api/run", executeRoutes);
app.route("/api/execute", executeRoutes);
app.route("/api/database", databaseRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/connectors", connectorRoutes);
app.route("/api/databases", databaseSchemaRoutes);

// Documentation routes
app.get("/api/doc", c => c.json(openApiSpec));
app.get("/api/swagger", swaggerUI({ url: "/api/doc" }));

// Register database drivers
databaseRegistry.register(new MySQLDatabaseDriver());


// Inngest endpoint
app.on(
  ["GET", "PUT", "POST"],
  "/api/inngest",
  serveInngest({
    client: inngest,
    functions,
  }),
);


// Fallback handler for unknown non-API routes
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/") || c.req.path === "/health") {
    await next();
    return;
  }
  return c.json({ success: false, error: "Not Found" }, 404);
});

const port = parseInt(process.env.WEB_API_PORT || process.env.PORT || "8080");

let server: any = null;

/**
 * Main entry point - starts the server
 * Note: Logging is auto-initialized via top-level await in the logging module,
 * so all loggers created at module level are already configured
 */
async function main(): Promise<void> {
  if (fs.existsSync(envPath)) {
    logger.info("Loaded environment variables", { path: envPath });
  } else {
    logger.warn(
      "No .env file found, environment variables must be set another way",
      { path: envPath },
    );
  }

  // TiDB Direct Mode — MongoDB not used
  logger.info("Running in TiDB Direct Mode. MongoDB is not required.");

  // Pre-load full schema cache for AI agents (MakoAI-style)
  initSchemaCache().then(() => {
    logger.info("[schema-cache] Full schema pre-loaded for AI agents");
  }).catch((err) => {
    logger.warn("[schema-cache] Schema pre-load failed (will retry on first request)", { error: err });
  });

  // Log Inngest configuration status (after logging is initialized)
  logInngestStatus();

  // Log server startup info
  logger.info("Server starting", {
    port,
    environment: process.env.NODE_ENV || "development",
    endpoints: {
      api: "/api/*",
      inngest: "/api/inngest",
      health: "/health",
    },
  });

  // Start the server
  server = serve({
    fetch: app.fetch,
    port,
  });
}

// Start the application
main().catch(error => {
  // Use console.error here since logging might not be initialized
  console.error("Fatal error during startup:", error);
  throw error;
});

// Graceful shutdown handling
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

// Process-level safety nets: log and keep server responsive
process.on("unhandledRejection", reason => {
  logger.error("Unhandled Promise Rejection", { reason });
});

process.on("uncaughtException", err => {
  logger.error("Uncaught Exception", { error: err });
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info("Graceful shutdown initiated", { signal });

  // Set a timeout to force exit if shutdown hangs
  const forceExitTimeout = setTimeout(() => {
    logger.warn("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10000); // 10 seconds

  try {
    // Close the Hono server if it's running
    if (server) {
      logger.info("Closing HTTP server");

      // Close all active connections for faster port release
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }

      await new Promise<void>((resolve, reject) => {
        server.close((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info("HTTP server closed");
    }

    // Close TiDB/MySQL connection pool
    logger.info("Closing database connection pool");
    await databaseConnectionService.closeAllConnections();
    logger.info("Database connection pool closed");

    clearTimeout(forceExitTimeout);
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during graceful shutdown", { error });
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}
