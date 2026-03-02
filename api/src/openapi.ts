/**
 * OpenAPI specification for the Mako API (TiDB Direct Mode)
 */
export const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "Mako Backend API",
    version: "2.0.0",
    description:
      "AI-powered TiDB query assistant. Send a question and get a structured report back.",
  },
  servers: [
    {
      url: "/api",
      description: "Base API path",
    },
  ],
  paths: {
    "/agent/chat": {
      post: {
        summary: "Ask AI a Question",
        description:
          "Send a natural-language question. The AI will query the TiDB database and return a plain-text report (Title, Table, Summary).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["question"],
                properties: {
                  question: {
                    type: "string",
                    description: "The user's natural-language question",
                    example: "How many students passed this semester?",
                  },
                  model: {
                    type: "string",
                    description: "AI model to use",
                    default: "deepseek-chat",
                    example: "deepseek-chat",
                  },
                  user_id: {
                    type: "integer",
                    description: "ID of the requesting user (for role-based filtering)",
                    example: 35,
                  },
                  user_role: {
                    type: "integer",
                    description: "Role ID of the requesting user (for role-based filtering)",
                    example: 7,
                  },
                  stream: {
                    type: "boolean",
                    description: "Set to true for SSE streaming text response",
                    default: false,
                  },
                },
              },
              examples: {
                basicQuestion: {
                  summary: "Basic question",
                  value: {
                    question: "How many students are in the database?",
                    model: "deepseek-chat",
                    user_id: 35,
                    user_role: 7,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Plain-text AI report (Title, Data Table, Summary)",
            content: {
              "text/plain": {
                schema: { type: "string" },
                example:
                  "Total Students\n\n| student_id | name       |\n|------------|------------|\n| 1          | Alice Kumar|\n\n1 student found in the database.",
              },
            },
          },
          400: {
            description: "Bad request (missing 'question')",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/agent/chat-v2": {
      post: {
        summary: "Ask AI a Question (3-Tool Mode)",
        description:
          "Advanced endpoint where the AI dynamically uses 3 tools (`list_tables`, `describe_table`, `run_sql`) to discover data before generating a MakoAI style report. Highly accurate for complex queries.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["question"],
                properties: {
                  question: {
                    type: "string",
                    description: "The user's natural-language question",
                    example: "Who is the best student in SREC?",
                  },
                  model: {
                    type: "string",
                    description: "AI model to use",
                    default: "deepseek-chat",
                    example: "deepseek-chat",
                  },
                  user_id: {
                    type: "integer",
                    description: "ID of the requesting user",
                    example: 35,
                  },
                  user_role: {
                    type: "integer",
                    description: "Role ID of the requesting user",
                    example: 7,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Plain-text AI report (Title, Data Table, Summary)",
            content: {
              "text/plain": {
                schema: { type: "string" },
                example: "## SREC Top Students\n\n| name | score |\n|------|-------|\n| John | 95.5  |\n\nFound 1 student.",
              },
            },
          },
          400: {
            description: "Bad request",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/agent/models": {
      get: {
        summary: "List available AI models",
        responses: {
          200: {
            description: "List of models",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    models: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          provider: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/execute": {
      post: {
        summary: "Execute SQL directly",
        description: "Run a raw SQL query against the TiDB database.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: {
                  content: {
                    type: "string",
                    description: "The SQL query to execute",
                    example: "SELECT COUNT(*) FROM students;",
                  },
                  databaseId: {
                    type: "string",
                    description: "Optional database connection ID",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Query results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: {
                      type: "object",
                      properties: {
                        results: { type: "array", items: { type: "object" } },
                        resultCount: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          200: {
            description: "Server is running",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    timestamp: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
