import mongoose from "mongoose";
import { Hono } from "hono";
import { Chat } from "../database/workspace-schema";
import { ObjectId } from "mongodb";
import { getConsolesByIds } from "../services/agent-thread.service";
import { loggers, enrichContextWithWorkspace } from "../logging";

const logger = loggers.api("chats");

/**
 * Extract unique console IDs from modify_console and create_console tool calls in chat messages.
 * This is used to determine which consoles should be restored when opening a chat.
 */
function extractModifiedConsoleIds(
  messages: Array<{
    toolCalls?: Array<{ toolName: string; input?: any; result?: any }>;
  }>,
): string[] {
  const consoleIds = new Set<string>();

  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      // modify_console: consoleId is in the input
      if (tc.toolName === "modify_console" && tc.input?.consoleId) {
        consoleIds.add(tc.input.consoleId);
      }
      // create_console: consoleId is in the result (output)
      if (tc.toolName === "create_console" && tc.result?.consoleId) {
        consoleIds.add(tc.result.consoleId);
      }
    }
  }

  return Array.from(consoleIds);
}

export const chatsRoutes = new Hono();

// Middleware to enrich logging context
chatsRoutes.use("*", async (c, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// List chat sessions (most recent first)
chatsRoutes.get("/", async (c) => {
  try {
    // Since auth is removed, use anonymous user
    const userId = "anonymous-user";

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;

    if (!ObjectId.isValid(workspaceId)) {
      return c.json({ error: "Invalid workspace id" }, 400);
    }

    if (process.env.BYPASS_AUTH === "true" || mongoose.connection.readyState !== 1) {
      return c.json([]);
    }

    // Filter by both workspaceId AND createdBy for privacy
    const chats = await Chat.find(
      {
        workspaceId: new ObjectId(workspaceId),
        createdBy: userId.toString(),
      },
      { messages: 0 },
    ).sort({ updatedAt: -1 });

    // Convert ObjectId to string for frontend convenience
    const mapped = chats.map(chat => ({
      ...chat.toObject(),
      _id: chat._id.toString(),
    }));

    return c.json(mapped);
  } catch (error) {
    logger.error("Error listing chats", { error });
    return c.json({ error: "Failed to list chats" }, 500);
  }
});

// Create a new chat session
chatsRoutes.post("/", async (c) => {
  try {
    // Since auth is removed, use anonymous user
    const userId = "anonymous-user";

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;

    if (!ObjectId.isValid(workspaceId)) {
      return c.json({ error: "Invalid workspace id" }, 400);
    }

    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // Ignore JSON parse errors – request body can be empty for this endpoint
    }

    const title = (body?.title as string) || "New Chat";

    // Direct Mode Bypass
    if (process.env.BYPASS_AUTH === "true" || mongoose.connection.readyState !== 1) {
      return c.json({ chatId: new ObjectId().toString() });
    }

    const now = new Date();
    const chat = new Chat({
      workspaceId: new ObjectId(workspaceId),
      title,
      messages: [],
      createdBy: userId.toString(), // Set actual user ID
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
    });

    await chat.save();

    return c.json({ chatId: chat._id.toString() });
  } catch (error) {
    logger.error("Error creating chat", { error });
    return c.json({ error: "Failed to create chat" }, 500);
  }
});

// Get a single chat session with messages and associated consoles
chatsRoutes.get("/:id", async (c) => {
  try {
    // Since auth is removed, use anonymous user
    const userId = "anonymous-user";

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;
    const id = c.req.param("id");

    if (!ObjectId.isValid(workspaceId)) {
      return c.json({ error: "Invalid workspace id" }, 400);
    }

    if (!ObjectId.isValid(id)) {
      return c.json({ error: "Invalid chat id" }, 400);
    }

    // Filter by workspaceId, chat id, AND createdBy for privacy
    if (process.env.BYPASS_AUTH === "true" || mongoose.connection.readyState !== 1) {
      return c.json({
        _id: id,
        workspaceId: workspaceId,
        title: "Direct Mode Chat",
        messages: [],
        createdBy: userId.toString(),
        createdAt: new Date(),
        updatedAt: new Date(),
        consoles: [],
      });
    }

    const chat = await Chat.findOne({
      _id: new ObjectId(id),
      workspaceId: new ObjectId(workspaceId),
      createdBy: userId.toString(),
    });

    if (!chat) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // Extract console IDs from modify_console tool calls in chat messages
    // These are consoles that the agent modified during this conversation
    const modifiedConsoleIds = extractModifiedConsoleIds(chat.messages || []);

    // Fetch the consoles that were modified (they should be saved as drafts)
    const consoles = await getConsolesByIds(modifiedConsoleIds);

    return c.json({
      ...chat.toObject(),
      _id: chat._id.toString(),
      consoles, // Include consoles that were modified by the agent
    });
  } catch (error) {
    logger.error("Error getting chat", { error });
    return c.json({ error: "Failed to get chat" }, 500);
  }
});

// Update chat title (optional future use)
chatsRoutes.put("/:id", async (c) => {
  try {
    // Since auth is removed, use anonymous user
    const userId = "anonymous-user";

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;
    const id = c.req.param("id");

    if (!ObjectId.isValid(workspaceId)) {
      return c.json({ error: "Invalid workspace id" }, 400);
    }

    if (!ObjectId.isValid(id)) {
      return c.json({ error: "Invalid chat id" }, 400);
    }

    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // Ignore JSON parse errors – request body can be empty for this endpoint
    }

    const { title } = body;
    if (!title) {
      return c.json({ error: "'title' is required" }, 400);
    }

    // Only update if user owns the chat
    if (process.env.BYPASS_AUTH === "true" || mongoose.connection.readyState !== 1) {
      return c.json({ success: true });
    }

    const result = await Chat.findOneAndUpdate(
      {
        _id: new ObjectId(id),
        workspaceId: new ObjectId(workspaceId),
        createdBy: userId.toString(),
      },
      { title, updatedAt: new Date() },
      { new: true },
    );

    if (!result) {
      return c.json({ error: "Chat not found" }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    logger.error("Error updating chat", { error });
    return c.json({ error: "Failed to update chat" }, 500);
  }
});

// Delete a chat session
chatsRoutes.delete("/:id", async (c) => {
  try {
    // Since auth is removed, use anonymous user
    const userId = "anonymous-user";

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;
    const id = c.req.param("id");

    if (!ObjectId.isValid(workspaceId)) {
      return c.json({ error: "Invalid workspace id" }, 400);
    }

    if (!ObjectId.isValid(id)) {
      return c.json({ error: "Invalid chat id" }, 400);
    }

    // Only delete if user owns the chat
    if (process.env.BYPASS_AUTH === "true" || mongoose.connection.readyState !== 1) {
      return c.json({ success: true });
    }

    const result = await Chat.findOneAndDelete({
      _id: new ObjectId(id),
      workspaceId: new ObjectId(workspaceId),
      createdBy: userId.toString(),
    });

    if (!result) {
      return c.json({ error: "Chat not found" }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    logger.error("Error deleting chat", { error });
    return c.json({ error: "Failed to delete chat" }, 500);
  }
});
