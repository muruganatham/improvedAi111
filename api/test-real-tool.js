const { generateText, tool } = require('ai');
const { createDeepSeek } = require('@ai-sdk/deepseek');
const { z } = require('zod');
require('dotenv').config({ path: '../.env' });

const deepseek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const model = deepseek("deepseek-chat");

generateText({
  model,
  messages: [{role:'user',content:'query the students table'}],
  tools: {
    sql_execute_query: tool({
      description: "Execute a MySQL/TiDB query and return results.",
      parameters: z.object({
        connectionId: z.string().describe("The connection ID"),
        database: z.string().describe("The database name"),
        query: z.string().describe("The SQL query to execute"),
      }),
      execute: async (params) => { 
        console.log("SQL EXECUTE CALLED:", params);
        return { success: true, data: [] };
      },
    }),
  }
}).then(r => console.log("SUCCESS:", r.text))
  .catch(e => console.error("FAILED:", e.message));
