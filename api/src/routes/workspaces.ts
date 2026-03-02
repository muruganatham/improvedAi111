/**
 * Workspace Routes — TiDB Direct Mode stubs
 *
 * MongoDB is not connected. All workspace routes return safe stub responses
 * so the server doesn't 500. Real workspace management is not used in Direct Mode.
 */

import { Hono } from "hono";
import { loggers } from "../logging";

const logger = loggers.workspace();
export const workspaceRoutes = new Hono();

// ── Stub helpers ──────────────────────────────────────────────────────────────

const defaultWorkspace = {
  id: "default-workspace",
  name: "Default Workspace",
  slug: "default",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const authRequired = (c: any) =>
  c.json({ success: false, error: "Authentication is required" }, 401);

// ── Routes ────────────────────────────────────────────────────────────────────

workspaceRoutes.get("/pending-invites", (c) =>
  c.json({ success: true, data: [] })
);

workspaceRoutes.get("/", (c) =>
  c.json({ success: true, data: [defaultWorkspace] })
);

workspaceRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ success: false, error: "Workspace name is required" }, 400);
    }
    return c.json(
      {
        success: true,
        data: {
          id: "default-workspace",
          name: body.name,
          slug: body.slug || "default",
          createdAt: new Date().toISOString(),
        },
        message: "Workspace created (Direct Mode stub)",
      },
      201
    );
  } catch (error) {
    logger.error("Error in workspace create stub", { error });
    return c.json({ success: false, error: "Invalid request" }, 400);
  }
});

workspaceRoutes.get("/current", (c) =>
  c.json({ success: true, data: defaultWorkspace })
);

workspaceRoutes.get("/invites/:token", (c) =>
  c.json({ success: false, error: "Invitations not available in Direct Mode" }, 404)
);

workspaceRoutes.post("/invites/:token/accept", authRequired as any);

workspaceRoutes.get("/:id", (c) =>
  c.json({ success: true, data: defaultWorkspace })
);

workspaceRoutes.put("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    success: true,
    data: { ...defaultWorkspace, ...body },
    message: "Workspace updated (Direct Mode stub)",
  });
});

workspaceRoutes.delete("/:id", (c) =>
  c.json({ success: true, message: "Workspace deleted (Direct Mode stub)" })
);

workspaceRoutes.post("/:id/switch", (c) =>
  c.json({ success: true, message: "Workspace switched" })
);

workspaceRoutes.get("/:id/members", (c) =>
  c.json({ success: true, data: [] })
);
workspaceRoutes.post("/:id/members", authRequired as any);
workspaceRoutes.put("/:id/members/:userId", authRequired as any);
workspaceRoutes.delete("/:id/members/:userId", authRequired as any);

workspaceRoutes.post("/:id/invites", authRequired as any);
workspaceRoutes.get("/:id/invites", (c) => c.json({ success: true, data: [] }));
workspaceRoutes.delete("/:id/invites/:inviteId", authRequired as any);

workspaceRoutes.get("/:id/api-keys", (c) => c.json({ success: true, data: [] }));
workspaceRoutes.post("/:id/api-keys", authRequired as any);
workspaceRoutes.delete("/:id/api-keys/:keyId", authRequired as any);
