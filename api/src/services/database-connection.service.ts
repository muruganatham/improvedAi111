import * as mysql from "mysql2/promise";
import { IDatabaseConnection } from "../database/workspace-schema";
import mongoose from "mongoose";
import { loggers } from "../logging";

const logger = loggers.db();

export interface QueryResult {
  success: boolean;
  data?: any;
  error?: string;
  rowCount?: number;
  fields?: any[];
}

// Types for different connection contexts
export type ConnectionContext =
  | "main" // Main application database
  | "destination" // Destination databases for sync
  | "datasource" // Data source databases
  | "workspace"; // Workspace-specific databases

export interface ConnectionConfig {
  connectionString: string;
  database: string;
}

/**
 * Options for query execution
 * Used consistently across all database drivers
 */
export interface QueryExecuteOptions {
  /** Target database name (for cluster/server-level connections) */
  databaseName?: string;
  /** Sub-database ID (e.g., Cloudflare D1 database UUID) */
  databaseId?: string;
  /** Batch size for paginated queries (BigQuery) */
  batchSize?: number;
  /** Location/region for query execution (BigQuery) */
  location?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Execution ID for job tracking (enables cancellation) */
  executionId?: string;
}

/**
 * Options for the retry utility
 */
interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay in milliseconds (doubles with each retry) */
  baseDelayMs: number;
  /** Optional: only retry if error matches these patterns */
  retryableErrorPatterns?: RegExp[];
  /** Optional: abort signal to cancel retries */
  signal?: AbortSignal;
}

/**
 * Default patterns for retryable connection errors
 * These indicate transient failures that may succeed on retry
 */
const DEFAULT_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  // Connection errors
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /ENETUNREACH/i,
  /EHOSTUNREACH/i,
  /EAI_AGAIN/i,
  // Timeout errors
  /timeout/i,
  /timed out/i,
  // Connection closed/reset
  /connection.*closed/i,
  /connection.*reset/i,
  /connection.*terminated/i,
  /socket hang up/i,
  // Server temporarily unavailable (cold start)
  /service unavailable/i,
  /503/i,
  /502/i,
  /temporarily unavailable/i,
  // ClickHouse specific
  /Code: 159/i, // TIMEOUT_EXCEEDED
  /Code: 209/i, // SOCKET_TIMEOUT
  /Code: 210/i, // NETWORK_ERROR
];

/**
 * Patterns for errors that should NOT be retried
 * These indicate permanent failures (syntax errors, auth issues, etc.)
 */
const NON_RETRYABLE_ERROR_PATTERNS: RegExp[] = [
  // SQL syntax errors
  /syntax error/i,
  /parse error/i,
  // Authentication/authorization
  /authentication failed/i,
  /access denied/i,
  /permission denied/i,
  /unauthorized/i,
  /invalid.*password/i,
  /invalid.*credentials/i,
  // Invalid queries
  /unknown.*table/i,
  /unknown.*column/i,
  /unknown.*database/i,
  /does not exist/i,
  /no such/i,
  // Query cancelled by user
  /cancelled/i,
  /aborted/i,
];

/**
 * Check if an error is retryable based on error patterns
 */
function isRetryableError(error: Error, customPatterns?: RegExp[]): boolean {
  const errorMessage = error.message || "";
  const errorName = error.name || "";
  const fullErrorString = `${errorName}: ${errorMessage}`;

  // First check if it's explicitly non-retryable
  for (const pattern of NON_RETRYABLE_ERROR_PATTERNS) {
    if (pattern.test(fullErrorString)) {
      return false;
    }
  }

  // Then check if it matches retryable patterns
  const patterns = customPatterns || DEFAULT_RETRYABLE_ERROR_PATTERNS;
  for (const pattern of patterns) {
    if (pattern.test(fullErrorString)) {
      return true;
    }
  }

  return false;
}

/**
 * Execute a function with retry logic and exponential backoff
 * Used for transient connection failures and cold starts
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, retryableErrorPatterns, signal } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if cancelled
    if (signal?.aborted) {
      throw new Error("Operation cancelled");
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if this is the last attempt
      if (attempt >= maxRetries) {
        break;
      }

      // Don't retry non-retryable errors
      if (!isRetryableError(lastError, retryableErrorPatterns)) {
        break;
      }

      // Calculate delay with exponential backoff
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      logger.debug("Retry attempt failed, retrying", {
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        error: lastError.message,
        delayMs,
      });

      // Wait before retrying
      await new Promise<void>((resolve, reject) => {
        const abortHandler = () => {
          clearTimeout(timeoutId);
          reject(new Error("Operation cancelled"));
        };

        const timeoutId = setTimeout(() => {
          // Clean up abort listener when timeout completes normally
          if (signal) {
            signal.removeEventListener("abort", abortHandler);
          }
          resolve();
        }, delayMs);

        if (signal) {
          signal.addEventListener("abort", abortHandler, { once: true });
        }
      });
    }
  }

  throw lastError;
}

/**
 * Enhanced Database Connection Service
 *
 * Provides unified connection management for all database types with:
 * - Advanced MongoDB connection pooling with health checks
 * - Multi-database support (PostgreSQL, MySQL, MSSQL, BigQuery, Cloudflare D1/KV)
 * - Automatic reconnection and idle cleanup
 * - Unified query execution interface
 */
export class DatabaseConnectionService {
  private connections: Map<string, any> = new Map();
  private mysqlPools: Map<string, { pool: mysql.Pool; lastUsed: Date }> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly userDatabaseMaxIdleTime = 15 * 60 * 1000; // 15 minutes - keep user database pools alive during active sessions

  constructor() {
    // Start cleanup interval for idle connections (MySQL)
    this.cleanupInterval = setInterval(() => {
      void this.cleanupIdleMySQLPools();
    }, 60000); // Every minute
  }

  /**
   * Test database connection
   */
  async testConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      switch (database.type) {
        case "mysql":
          return await this.testMySQLConnection(database);
        default:
          return {
            success: false,
            error: `Unsupported database type: ${database.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute query on database
   */
  async executeQuery(
    database: IDatabaseConnection | any,
    query: any,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    // Direct Mode Fallback
    if (database.id === "000000000000000000000002" || database._id?.toString() === "000000000000000000000002") {
      database = {
        _id: new mongoose.Types.ObjectId("000000000000000000000002"),
        type: "mysql",
        connection: {
          host: process.env.DB_HOST,
          port: parseInt(process.env.DB_PORT || "4000"),
          database: process.env.DB_NAME,
          username: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
        }
      };
    }
    try {
      switch (database.type) {
        case "mysql":
          return await this.executeMySQLQuery(database, query, options);
        default:
          return {
            success: false,
            error: `Unsupported database type: ${database.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get database connection
   */
  async getConnection(database: IDatabaseConnection): Promise<any> {
    const key = database._id.toString();

    // For MySQL, use dedicated pool management
    if (database.type === "mysql") {
      return this.getMySQLPool(database);
    }

    // For other database types, use basic caching
    if (this.connections.has(key)) {
      return this.connections.get(key);
    }

    let connection: any;

    switch (database.type) {
      default:
        throw new Error(`Unsupported database type: ${database.type}`);
    }

    this.connections.set(key, connection);
    return connection;
  }

  /**
   * Close database connection
   */
  async closeConnection(databaseId: string): Promise<void> {

    // Close MySQL pools for this database
    await this.closeMySQLPool(databaseId);


    // Also handle any non-MySQL/non-PostgreSQL connections in the local cache
    const connection = this.connections.get(databaseId);
    if (connection) {
      try {
        if (connection.end) {
          await connection.end();
        } else if (connection.close) {
          await connection.close();
        }
      } catch (error) {
        logger.error("Error closing cached connection", { databaseId, error });
      } finally {
        this.connections.delete(databaseId);
      }
    }

  }

  /**
   * Close all connections
   */
  async closeAllConnections(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close MySQL pools
    await this.closeAllMySQLPools();

    // Close other connections
    const otherPromises = Array.from(this.connections.keys()).map(id =>
      this.closeConnection(id),
    );
    await Promise.all(otherPromises);
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    totalConnections: number;
    other: number;
  } {
    return {
      totalConnections: this.connections.size,
      other: this.connections.size,
    };
  }

  // MySQL client configuration constants
  private readonly mysqlConnectionTimeoutMs = 30_000;
  private readonly mysqlMaxRetries = 3;
  private readonly mysqlRetryBaseDelayMs = 1000;

  // MySQL specific methods
  private buildMySQLConfig(
    database: IDatabaseConnection,
    targetDatabase?: string,
  ) {
    const conn = database.connection;
    const baseConfig = {
      connectTimeout: this.mysqlConnectionTimeoutMs,
    };

    if (conn.connectionString) {
      try {
        let urlString = conn.connectionString;
        if (!urlString.startsWith("mysql://")) {
          urlString = `mysql://${urlString}`;
        }
        const url = new URL(urlString);
        if (targetDatabase) {
          url.pathname = `/${targetDatabase}`;
        }

        const sslParam = url.searchParams.get("ssl");
        const sslMode = url.searchParams.get("sslmode");
        const ssl =
          conn.ssl ||
          sslParam === "true" ||
          sslParam === "1" ||
          sslMode === "require" ||
          sslMode === "verify-ca" ||
          sslMode === "verify-full" ||
          sslMode === "prefer";

        return {
          host: url.hostname || undefined,
          port: url.port ? Number.parseInt(url.port, 10) : 3306,
          database: url.pathname.slice(1)
            ? decodeURIComponent(url.pathname.slice(1))
            : undefined,
          user: url.username ? decodeURIComponent(url.username) : undefined,
          password: url.password ? decodeURIComponent(url.password) : undefined,
          ssl: ssl ? { rejectUnauthorized: false } : undefined,
          ...baseConfig,
        };
      } catch (error) {
        logger.warn("Failed to parse MySQL connection string", { error });
      }
    }

    return {
      host: conn.host,
      port: conn.port || 3306,
      database: targetDatabase || conn.database,
      user: conn.username,
      password: conn.password,
      ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
      ...baseConfig,
    };
  }

  private async getMySQLPool(
    database: IDatabaseConnection,
    targetDatabase?: string,
  ): Promise<mysql.Pool> {
    const dbName = targetDatabase || database.connection.database || "";
    const key = `${database._id.toString()}:${dbName}`;

    const existing = this.mysqlPools.get(key);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.pool;
    }

    const config = this.buildMySQLConfig(database, targetDatabase);
    const pool = mysql.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit: 10,  // Increased from 2 — AI agents make multiple concurrent queries
      maxIdle: 5,           // Increased from 2 — keep more idle connections warm
      idleTimeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
    });

    pool.on("connection", connection => {
      connection.on("error", err => {
        logger.error("MySQL pool connection error", {
          key,
          error: err instanceof Error ? err.message : err,
        });
        const entry = this.mysqlPools.get(key);
        if (entry?.pool === pool) {
          this.mysqlPools.delete(key);
        }
        pool.end().catch(endErr => {
          logger.error("Error closing MySQL pool after error", {
            key,
            error: endErr,
          });
        });
      });
    });

    this.mysqlPools.set(key, { pool, lastUsed: new Date() });
    logger.debug("Created MySQL pool", { key });
    return pool;
  }

  private async closeMySQLPool(databaseId: string): Promise<void> {
    const poolsToClose: Array<{ key: string; pool: mysql.Pool }> = [];
    for (const [key, { pool }] of this.mysqlPools.entries()) {
      if (key.startsWith(`${databaseId}:`)) {
        poolsToClose.push({ key, pool });
      }
    }

    for (const { key } of poolsToClose) {
      this.mysqlPools.delete(key);
    }

    for (const { key, pool } of poolsToClose) {
      try {
        await pool.end();
        logger.debug("Closed MySQL pool", { key });
      } catch (error) {
        logger.error("Error closing MySQL pool", { key, error });
      }
    }
  }

  private async closeAllMySQLPools(): Promise<void> {
    const poolsToClose = Array.from(this.mysqlPools.entries());
    this.mysqlPools.clear();

    const promises = poolsToClose.map(async ([key, { pool }]) => {
      try {
        await pool.end();
        logger.debug("Closed MySQL pool", { key });
      } catch (error) {
        logger.error("Error closing MySQL pool", { key, error });
      }
    });
    await Promise.all(promises);
  }

  private async cleanupIdleMySQLPools(): Promise<void> {
    const now = new Date();
    const toRemove: string[] = [];

    for (const [key, { lastUsed }] of this.mysqlPools.entries()) {
      const idleTime = now.getTime() - lastUsed.getTime();
      if (idleTime > this.userDatabaseMaxIdleTime) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      const entry = this.mysqlPools.get(key);
      if (entry) {
        const idleTime = now.getTime() - entry.lastUsed.getTime();
        if (idleTime <= this.userDatabaseMaxIdleTime) {
          continue;
        }
        this.mysqlPools.delete(key);
        try {
          await entry.pool.end();
          logger.info("Closed idle MySQL pool", { key });
        } catch (error) {
          logger.error("Error closing idle MySQL pool", { key, error });
        }
      }
    }
  }

  private async testMySQLConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    let connection: mysql.Connection | null = null;
    try {
      const config = this.buildMySQLConfig(database);
      connection = await mysql.createConnection(config);
      await connection.ping();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "MySQL connection failed",
      };
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  }

  private normalizeMySQLValue(value: unknown): unknown {
    if (Buffer.isBuffer(value)) {
      const text = value.toString("utf8");
      const trimmed = text.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return text;
        }
      }
      return text;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.normalizeMySQLValue(item));
    }

    // Handle Date objects before generic object check - mysql2 returns
    // DATETIME, TIMESTAMP, and DATE columns as JavaScript Date objects.
    // Date passes typeof === "object" but Object.entries() returns [] since
    // Date has no enumerable own properties, which would convert dates to {}.
    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) {
        normalized[key] = this.normalizeMySQLValue(entry);
      }
      return normalized;
    }

    return value;
  }

  private async executeMySQLQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    const signal = options?.signal;
    const targetDatabase =
      options?.databaseName || database.connection.database;

    try {
      if (signal?.aborted) {
        return { success: false, error: "Query cancelled" };
      }

      const pool = await this.getMySQLPool(database, targetDatabase);
      const connection = await withRetry(async () => pool.getConnection(), {
        maxRetries: this.mysqlMaxRetries,
        baseDelayMs: this.mysqlRetryBaseDelayMs,
        signal,
      });

      try {
        if (signal?.aborted) {
          return { success: false, error: "Query cancelled" };
        }

        const [rows, fields] = await connection.execute(query);
        const normalizedRows = Array.isArray(rows)
          ? rows.map(row => this.normalizeMySQLValue(row))
          : rows;
        const normalizedFields = Array.isArray(fields)
          ? fields.map(field => {
            const fieldPacket =
              field && typeof field === "object"
                ? (field as mysql.FieldPacket)
                : undefined;
            return {
              name: fieldPacket?.name,
              type: fieldPacket?.type ?? fieldPacket?.columnType,
              columnType: fieldPacket?.columnType,
              columnLength: fieldPacket?.columnLength,
              decimals: fieldPacket?.decimals,
              flags: fieldPacket?.flags,
              characterSet: fieldPacket?.characterSet,
              encoding: fieldPacket?.encoding,
            };
          })
          : fields;
        return {
          success: true,
          data: normalizedRows,
          fields: normalizedFields,
        };
      } finally {
        connection.release();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "MySQL query failed",
      };
    }
  }

}

// Export singleton instance
export const databaseConnectionService = new DatabaseConnectionService();
