import { Db } from "mongodb";
import dotenv from "dotenv";
import { DatabaseConnection } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.db("mongodb");

dotenv.config({ path: "../../.env" });

export interface MongoConfig {
  connectionString: string;
  database: string;
}

class MongoDBConnection {
  private static instance: MongoDBConnection;

  private constructor() { }

  public static getInstance(): MongoDBConnection {
    if (!MongoDBConnection.instance) {
      MongoDBConnection.instance = new MongoDBConnection();
    }
    return MongoDBConnection.instance;
  }

  /**
   * Get a database connection by database ID
   */
  public async getDatabase(databaseId: string): Promise<Db> {
    // Get the database config from Database model
    const dbRecord = await DatabaseConnection.findById(databaseId);

    if (!dbRecord) {
      throw new Error(`Database '${databaseId}' not found in configuration`);
    }

    if (!dbRecord.connection.connectionString) {
      throw new Error(`Database '${databaseId}' is missing connection string`);
    }

    logger.info("Getting MongoDB connection", {
      databaseId,
      database: dbRecord.connection.database || "default",
      name: dbRecord.name,
    });

    // MongoDB connections are not supported in TiDB Direct Mode
    throw new Error("MongoDB connections are not supported in TiDB Direct Mode");
  }

  /**
   * Disconnect from a specific database
   * Note: With unified pool, this is a no-op as connections are managed by the pool
   */
  public async disconnect(databaseId: string): Promise<void> {
    logger.info("Disconnect requested - handled by pool", { databaseId });
  }

  /**
   * Disconnect from all databases
   * Note: With unified pool, this is a no-op as connections are managed by the pool
   */
  public async disconnectAll(): Promise<void> {
    logger.info("Disconnect all requested - handled by pool");
  }
}

export const mongoConnection = MongoDBConnection.getInstance();
