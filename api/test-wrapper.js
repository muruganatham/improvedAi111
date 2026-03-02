const { generateText, tool, wrapLanguageModel } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
const { z } = require('zod');
require('dotenv').config({ path: '../.env' });

const deepseek = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const model = deepseek.chat("deepseek-chat");

const wrappedModel = wrapLanguageModel({
  model,
  middleware: {
    transformArgs: async ({ args }) => {
      console.log("---- WRAPPER ARGS.TOOLS ----");
      console.dir(args.tools, { depth: null });
      if (args.tools) {
        args.tools = args.tools.map(t => {
          if (t.type === 'function') {
             t.function.parameters.type = 'object';
             // Ensure properties is not empty if it's there
             if (!t.function.parameters.properties) {
                t.function.parameters.properties = {};
             }
          }
          return t;
        });
      }
      console.log("---- FINAL ARGS.TOOLS ----");
      console.dir(args.tools, { depth: null });
      return args;
    },
  },
});

generateText({
  model: wrappedModel,
  messages: [{role:'user',content:'hi'}],
  tools: {
    list_connections: tool({
      description: 'test',
      parameters: z.object({ _dummy: z.string().optional() }),
      execute: async () => { console.log("executed"); }
    })
  }
}).then(r => console.log("SUCCESS:", r.text))
  .catch(e => console.error("FAILED:", e.message));
