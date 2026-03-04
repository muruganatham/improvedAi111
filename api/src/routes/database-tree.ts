/**
 * database-tree.ts — TiDB Direct Mode
 *
 * Provides database tree navigation (schema, tables, autocomplete).
 * All routes use TiDB Direct Mode — no auth middleware required.
 */

import { Hono } from "hono";
import { Types } from "mongoose";
import { databaseRegistry } from "../databases/registry";
import { DatabaseDriver } from "../databases/driver";
import { loggers } from "../logging";

const logger = loggers.api("database-tree");
export const databaseTreeRoutes = new Hono();

/** Build the TiDB direct connection object from .env */
function directTidbDb(databaseId: string) {
  return {
    _id: new Types.ObjectId(Types.ObjectId.isValid(databaseId) ? databaseId : "000000000000000000000002"),
    workspaceId: new Types.ObjectId("000000000000000000000001"),
    type: "mysql",
    name: "TiDB (Direct)",
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 4000),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    },
  } as any;
}

// GET /:id/tree
databaseTreeRoutes.get("/:id/tree", async (c) => {
  const databaseId = c.req.param("id");
  if (!Types.ObjectId.isValid(databaseId)) {
    return c.json({ success: false, error: "Invalid database ID" }, 400);
  }
  const database = directTidbDb(databaseId);
  const driver = databaseRegistry.getDriver(database.type);
  if (!driver) return c.json({ success: false, error: "Driver not found" }, 404);

  const nodeId = c.req.query("nodeId");
  const nodeKind = c.req.query("kind");
  const metadataRaw = c.req.query("metadata");

  try {
    if (!nodeId) {
      const nodes = await driver.getTreeRoot(database);
      return c.json({ success: true, data: nodes });
    }
    const metadata = metadataRaw ? JSON.parse(metadataRaw) : undefined;
    const nodes = await driver.getChildren(database, {
      id: String(nodeId),
      kind: String(nodeKind || ""),
      metadata,
    });
    return c.json({ success: true, data: nodes });
  } catch (error) {
    logger.error("Error getting database tree", { error });
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed to get tree" }, 500);
  }
});

// GET /:id/autocomplete
databaseTreeRoutes.get("/:id/autocomplete", async (c) => {
  const databaseId = c.req.param("id");
  if (!Types.ObjectId.isValid(databaseId)) {
    return c.json({ success: false, error: "Invalid database ID" }, 400);
  }
  const database = directTidbDb(databaseId);
  const driver = databaseRegistry.getDriver(database.type);
  if (!driver) return c.json({ success: false, error: "Driver not found" }, 404);

  if (!driver.getAutocompleteData) {
    return c.json({ success: false, error: "Autocomplete not supported for this database type" }, 400);
  }

  try {
    const schema = await driver.getAutocompleteData(database);
    return c.json({ success: true, data: schema });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch autocomplete data",
    }, 500);
  }
});

// GET /:id/console-template
databaseTreeRoutes.get("/:id/console-template", async (c) => {
  const databaseId = c.req.param("id");
  if (!Types.ObjectId.isValid(databaseId)) {
    return c.json({ success: false, error: "Invalid database ID" }, 400);
  }
  const database = directTidbDb(databaseId);
  const driver = databaseRegistry.getDriver(database.type) as
    | (DatabaseDriver & { getMetadata: () => { consoleLanguage?: string } })
    | undefined;

  if (!driver) return c.json({ success: false, error: "Driver not found" }, 404);

  const nodeId = c.req.query("nodeId");
  const nodeKind = c.req.query("kind");
  const metadataRaw = c.req.query("metadata");
  const metadata = metadataRaw ? JSON.parse(String(metadataRaw)) : undefined;

  const dbType = database.type;
  const language = (driver.getMetadata?.().consoleLanguage as string) || "sql";

  let template = "";
  if (dbType === "mongodb") {
    const collectionName = nodeId && String(nodeKind) === "collection" ? String(nodeId) : "collection";
    template = `db.getCollection("${collectionName}").find({}).limit(500)`;
  } else {
    const table = nodeId || metadata?.tableName || "table_name";
    template = `SELECT * FROM ${table} LIMIT 500;`;
  }

  return c.json({ success: true, data: { language, template } });
});

// GET /:id/table-exists
databaseTreeRoutes.get("/:id/table-exists", async (c) => {
  const databaseId = c.req.param("id");
  const tableName = c.req.query("tableName");
  const schema = c.req.query("schema");
  const database = directTidbDb(databaseId);

  if (!Types.ObjectId.isValid(databaseId)) {
    return c.json({ success: false, error: "Invalid database ID" }, 400);
  }
  if (!tableName) {
    return c.json({ success: false, error: "tableName is required" }, 400);
  }

  const driver = databaseRegistry.getDriver(database.type);
  if (!driver) return c.json({ success: false, error: "Driver not found" }, 404);

  if (!driver.tableExists) {
    return c.json({
      success: true,
      data: { exists: false, supported: false, message: `Table existence check not supported for ${database.type}` },
    });
  }

  try {
    const options: { schema?: string; database?: string } = {};
    if (schema) options.schema = String(schema);

    const exists = await driver.tableExists(database, String(tableName), options);
    if (!exists) return c.json({ success: true, data: { exists: false, columns: [] } });

    // For MySQL/TiDB — get column info
    let columns: Array<{ name: string; type: string; nullable?: boolean }> = [];
    const safeTable = String(tableName).replace(/'/g, "''");
    const safeDb = (process.env.DB_NAME || "").replace(/'/g, "''");
    const columnQuery = `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${safeDb}' AND table_name = '${safeTable}'
      ORDER BY ordinal_position;`;

    if (driver.executeQuery) {
      const result = await driver.executeQuery(database, columnQuery);
      if (result.success && result.data) {
        columns = result.data.map((row: any) => ({
          name: row.column_name || row.COLUMN_NAME,
          type: (row.data_type || row.DATA_TYPE || "UNKNOWN").toUpperCase(),
          nullable: (row.is_nullable || row.IS_NULLABLE) === "YES",
        }));
      }
    }

    return c.json({ success: true, data: { exists: true, columns } });
  } catch (error) {
    logger.error("Error checking table existence", { error, tableName });
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to check table existence",
    }, 500);
  }
});
