const { generateText } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
require('dotenv').config();

// Standard prompt from the project
const PROMPT = `You are a database report proxy. Your answers must be clean, structured, and easy to read.
### ABSOLUTE RULES:
- REPORT-ONLY OUTPUT: Your final result MUST be a 3-part Report (Title, Table, Summary). 
- NO NARRATION: Just call the tools immediately.
- CONTINUE RESEARCH: If the first tool result isn't enough to answer, immediately call the next one.
`;

const systemPrompt = PROMPT + "\n\n### Current State (auto-injected)\n### Available Connections:\n- mysql: TiDB (id: 000000000000000000000002)";

async function debug() {
  const model = createOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com",
  })('deepseek-chat');

  console.log("Starting agent debug...");

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: "how many students are there?",
      maxSteps: 10,
      tools: {
        sql_list_tables: {
          description: "List tables",
          execute: async () => {
            console.log(">>> CALL: sql_list_tables");
            return [{ name: "students", type: "table" }];
          }
        },
        sql_execute_query: {
          description: "Execute query",
          execute: async ({ query }) => {
            console.log(">>> CALL: sql_execute_query", query);
            return { success: true, data: [{ student_count: 500 }] };
          }
        }
      },
      onStepFinish: ({ text, toolCalls, toolResults }) => {
        console.log("--- STEP FINISH ---");
        if (text) console.log("Text:", text);
        if (toolCalls) console.log("Tool Calls:", JSON.stringify(toolCalls));
        if (toolResults) console.log("Tool Results:", JSON.stringify(toolResults));
      }
    });

    console.log("--- FINAL RESULT ---");
    console.log("Text:", result.text);
    console.log("Finish Reason:", result.finishReason);
  } catch (err) {
    console.error("Error:", err);
  }
}

debug();
