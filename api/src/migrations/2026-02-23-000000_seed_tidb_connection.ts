import { Db, ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";

export const description = "Seed default workspace and TiDB connection";

export async function up(db: Db): Promise<void> {
  // 1. Create a default workspace if none exists
  const workspaceId = "000000000000000000000001";
  const workspace = await db.collection("workspaces").findOne({ _id: new ObjectId(workspaceId) });
  
  if (!workspace) {
    await db.collection("workspaces").insertOne({
      _id: new ObjectId(workspaceId),
      name: "Default Workspace",
      slug: "default",
      settings: {
        theme: "light",
        notifications: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // 2. Add TiDB connection to this workspace
  const connectionId = new ObjectId();
  const tidbConnection = {
    _id: connectionId,
    workspaceId: new ObjectId(workspaceId),
    name: "TiDB Production",
    type: "mysql",
    connection: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "4000"),
      database: process.env.DB_NAME,
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD, // Note: In production this would be encrypted
      ssl: {
        rejectUnauthorized: true,
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Check if connection already exists
  const existing = await db.collection("databaseconnections").findOne({ 
    workspaceId: new ObjectId(workspaceId),
    name: "TiDB Production" 
  });

  if (!existing) {
    await db.collection("databaseconnections").insertOne(tidbConnection);
  }

  // 3. Create a default user if none exists (for local dev)
  const userId = uuidv4();
  const existingUser = await db.collection("users").findOne({});
  if (!existingUser) {
    await db.collection("users").insertOne({
      _id: new ObjectId(userId),
      email: "admin@mako.local",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add user as owner of default workspace
    await db.collection("workspacemembers").insertOne({
      workspaceId: new ObjectId(workspaceId),
      userId: userId,
      role: "owner",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}
