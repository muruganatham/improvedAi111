/**
 * Shared Database Discovery Tools
 *
 * Implementation functions for database discovery that can be used by multiple agents.
 * These handle listing connections, databases, tables, and table inspection.
 */

import { z } from "zod";
import { DatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { MYSQL_SYSTEM_DATABASES_SET } from "../../../databases/drivers/mysql/driver";
import {
  type SqlDialect,
  ALL_SQL_TYPES,
  ALL_SUPPORTED_TYPES,
  getDialect,
  getSqlDialectOrNull,
  ensureValidObjectId,
  escapePostgresIdentifier,
  escapeBigQueryIdentifier, // eslint-disable-line @typescript-eslint/no-unused-vars
  escapeMySqlIdentifier,
  escapeSqliteIdentifier, // eslint-disable-line @typescript-eslint/no-unused-vars
  escapeSqliteIdentifier as _,
} from "./sql-dialects";
import { MAX_SAMPLE_ROWS } from "./truncation";

// =============================================================================
// Zod Schemas (for tool definitions)
// =============================================================================

export const emptySchema = z.object({});

export const connectionIdSchema = z.object({
  connectionId: z.string().describe("The database connection ID"),
});

export const connectionAndDbSchema = z.object({
  connectionId: z.string().describe("The database connection ID"),
  database: z.string().describe("The database/dataset name"),
});

export const inspectTableSchema = z.object({
  connectionId: z.string().describe("The database connection ID"),
  database: z.string().describe("The database/dataset name"),
  table: z
    .string()
    .describe("The table name (may include schema prefix for Postgres)"),
});

// =============================================================================
// Helper: Fetch and validate database connection
// =============================================================================

interface FetchDatabaseOptions {
  /** If true, only allow SQL database types */
  sqlOnly?: boolean;
  /** If true, allow both SQL and MongoDB */
  includeNoSQL?: boolean;
}

async function fetchDatabase(
  connectionId: string,
  workspaceId: string,
  options: FetchDatabaseOptions = {},
) {
  const connectionObjectId = ensureValidObjectId(connectionId, "connectionId");
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const database = await DatabaseConnection.findOne({
    _id: connectionObjectId,
    workspaceId: workspaceObjectId,
  });

  if (!database) {
    throw new Error("Database connection not found or access denied");
  }

  const allowedTypes = options.includeNoSQL
    ? ALL_SUPPORTED_TYPES
    : options.sqlOnly
      ? ALL_SQL_TYPES
      : ALL_SUPPORTED_TYPES;

  if (!allowedTypes.has(database.type)) {
    throw new Error(
      `Unsupported database type: ${database.type}. Expected: ${Array.from(allowedTypes).join(", ")}`,
    );
  }

  return database;
}

// =============================================================================
// List Connections Implementation
// =============================================================================

export interface ConnectionInfo {
  id: string;
  name: string;
  type: string;
  dialect: string | null;
  displayName: string;
}

/**
 * List all database connections in a workspace
 * @param workspaceId - The workspace ID
 * @param options - Filter options (sqlOnly, includeNoSQL)
 */
export async function listConnectionsImpl(
  workspaceId: string,
  options: { sqlOnly?: boolean; includeNoSQL?: boolean } = {},
): Promise<ConnectionInfo[]> {
  const workspaceObjectId = ensureValidObjectId(workspaceId, "workspaceId");

  const allowedTypes = options.includeNoSQL
    ? ALL_SUPPORTED_TYPES
    : options.sqlOnly
      ? ALL_SQL_TYPES
      : ALL_SUPPORTED_TYPES;

  const databases = await DatabaseConnection.find({
    workspaceId: workspaceObjectId,
    type: { $in: Array.from(allowedTypes) },
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: Record<string, unknown> =
      (db as unknown as { connection: Record<string, unknown> }).connection ||
      {};
    const dialect = getSqlDialectOrNull(db.type);

    let displayInfo: string;
    if (db.type === "mongodb") {
      const databaseName = (connection.database as string) || "Unknown";
      displayInfo = databaseName;
    } else if (dialect === "postgresql" || dialect === "mysql") {
      const host = (connection.host || connection.instanceConnectionName) as
        | string
        | undefined;
      const dbName = (connection.database || connection.db) as
        | string
        | undefined;
      displayInfo = `${host || "unknown-host"}/${dbName || "unknown-db"}`;
    } else if (dialect === "bigquery") {
      displayInfo = (connection.project_id as string) || "unknown-project";
    } else {
      // SQLite/D1
      const dbId = connection.database_id as string | undefined;
      displayInfo = dbId || "main";
    }

    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      dialect: dialect || db.type,
      displayName: `${db.name} (${dialect || db.type}: ${displayInfo})`,
    };
  });
}

// =============================================================================
// List Databases Implementation
// =============================================================================

export interface DatabaseInfo {
  id?: string; // UUID for D1, otherwise same as name
  name: string;
  sqlDialect: SqlDialect;
}

/**
 * List databases/datasets within a connection
 * For D1 in cluster mode, returns both id (UUID) and name (human-readable)
 */
export async function listDatabasesImpl(
  connectionId: string,
  workspaceId: string,
): Promise<DatabaseInfo[]> {
  const database = await fetchDatabase(connectionId, workspaceId, {
    sqlOnly: true,
  });
  const dialect = getDialect(database.type);

  if (dialect === "postgresql") {
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname;`,
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list databases");
    }

    return (result.data || []).map((row: { datname: string }) => ({
      name: row.datname,
      sqlDialect: dialect,
    }));
  }

  if (dialect === "mysql") {
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      "SHOW DATABASES",
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list databases");
    }

    return (result.data || [])
      .map(
        (row: { Database?: string; database?: string }) =>
          row.Database || row.database,
      )
      .filter(
        (name: string | undefined): name is string =>
          !!name && !MYSQL_SYSTEM_DATABASES_SET.has(name),
      )
      .map((name: string) => ({
        name,
        sqlDialect: dialect,
      }));
  }

  return [{ name: "main", sqlDialect: dialect }];
}

// =============================================================================
// List Tables Implementation
// =============================================================================

export interface TableInfo {
  name: string;
  type: "table" | "view";
  schema?: string;
  sqlDialect: SqlDialect;
}

/**
 * List tables in a database
 */
export async function listTablesImpl(
  connectionId: string,
  databaseName: string,
  workspaceId: string,
): Promise<TableInfo[]> {
  if (!databaseName) {
    throw new Error("'database' is required");
  }

  const database = await fetchDatabase(connectionId, workspaceId, {
    sqlOnly: true,
  });
  const dialect = getDialect(database.type);

  if (dialect === "postgresql") {
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name;`,
      { databaseName },
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list tables");
    }

    return (result.data || []).map(
      (row: {
        table_schema: string;
        table_name: string;
        table_type: string;
      }) => ({
        name:
          row.table_schema === "public"
            ? row.table_name
            : `${row.table_schema}.${row.table_name}`,
        type: (row.table_type === "VIEW" ? "view" : "table") as
          | "table"
          | "view",
        schema: row.table_schema,
        sqlDialect: dialect,
      }),
    );
  }

  if (dialect === "mysql") {
    const safeDb = databaseName.replace(/'/g, "''");
    const result = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT table_name, table_type FROM information_schema.tables 
       WHERE table_schema = '${safeDb}' ORDER BY table_name;`,
      { databaseName },
    );

    if (!result.success) {
      throw new Error(result.error || "Failed to list tables");
    }

    return (result.data || []).map(
      (row: {
        table_name?: string;
        TABLE_NAME?: string;
        table_type?: string;
        TABLE_TYPE?: string;
      }) => ({
        name: (row.table_name || row.TABLE_NAME) as string,
        type: ((row.table_type || row.TABLE_TYPE) === "VIEW"
          ? "view"
          : "table") as "table" | "view",
        sqlDialect: dialect,
      }),
    );
  }

  throw new Error(`Unsupported database type: ${database.type}`);
}

// =============================================================================
// Inspect Table Implementation
// =============================================================================

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface TableInspectionResult {
  columns: ColumnInfo[];
  samples: Record<string, unknown>[];
  sqlDialect: SqlDialect;
  connectionName: string;
  connectionType: string;
}

/**
 * Inspect a table's schema and sample data
 */
export async function inspectTableImpl(
  connectionId: string,
  databaseName: string,
  tableName: string,
  workspaceId: string,
): Promise<TableInspectionResult> {
  if (!tableName) {
    throw new Error("'table' is required");
  }
  if (!databaseName) {
    throw new Error("'database' is required");
  }

  const database = await fetchDatabase(connectionId, workspaceId, {
    sqlOnly: true,
  });
  const dialect = getDialect(database.type);
  let columns: ColumnInfo[] = [];
  let samples: Record<string, unknown>[] = [];

  if (dialect === "postgresql") {
    // Split schema.table if needed - preserve table name parts after first dot
    let schemaName: string;
    let tblName: string;
    if (tableName.includes(".")) {
      const dotIndex = tableName.indexOf(".");
      schemaName = tableName.slice(0, dotIndex);
      tblName = tableName.slice(dotIndex + 1);
    } else {
      schemaName = "public";
      tblName = tableName;
    }

    const safeSchema = schemaName.replace(/'/g, "''");
    const safeTable = tblName.replace(/'/g, "''");

    // Get columns
    const colResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = '${safeSchema}' AND table_name = '${safeTable}'
       ORDER BY ordinal_position;`,
      { databaseName },
    );

    if (colResult.success && colResult.data) {
      columns = colResult.data.map(
        (row: {
          column_name: string;
          data_type: string;
          is_nullable: string;
        }) => ({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === "YES",
        }),
      );
    }

    // Get samples
    const quotedSchema = escapePostgresIdentifier(schemaName);
    const quotedTable = escapePostgresIdentifier(tblName);
    const sampleResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT * FROM ${quotedSchema}.${quotedTable} LIMIT ${MAX_SAMPLE_ROWS};`,
      { databaseName },
    );

    if (sampleResult.success && sampleResult.data) {
      samples = sampleResult.data.slice(0, MAX_SAMPLE_ROWS);
    }
  } else if (dialect === "mysql") {
    const safeDb = databaseName.replace(/'/g, "''");
    const safeTable = tableName.replace(/'/g, "''");

    // Get columns
    const colResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = '${safeDb}' AND table_name = '${safeTable}'
       ORDER BY ordinal_position;`,
      { databaseName },
    );

    if (colResult.success && colResult.data) {
      columns = colResult.data.map(
        (row: {
          column_name?: string;
          COLUMN_NAME?: string;
          data_type?: string;
          DATA_TYPE?: string;
          is_nullable?: string;
          IS_NULLABLE?: string;
        }) => ({
          name: (row.column_name || row.COLUMN_NAME) as string,
          type: (row.data_type || row.DATA_TYPE) as string,
          nullable: (row.is_nullable || row.IS_NULLABLE) === "YES",
        }),
      );
    }

    // Get samples
    const quotedTable = escapeMySqlIdentifier(tableName);
    const sampleResult = await databaseConnectionService.executeQuery(
      database as Parameters<typeof databaseConnectionService.executeQuery>[0],
      `SELECT * FROM ${quotedTable} LIMIT ${MAX_SAMPLE_ROWS};`,
      { databaseName },
    );

    if (sampleResult.success && sampleResult.data) {
      samples = sampleResult.data.slice(0, MAX_SAMPLE_ROWS);
    }
  }

  return {
    columns,
    samples,
    sqlDialect: dialect,
    connectionName: database.name,
    connectionType: database.type,
  };
}

// =============================================================================
// Re-export types and schemas for convenience
// =============================================================================

export { type SqlDialect } from "./sql-dialects";
