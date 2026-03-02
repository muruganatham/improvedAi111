const { generateText, tool } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
const { z } = require('zod');
require('dotenv').config({ path: '../.env' });

const customFetch = async (url, options) => {
  if (options.body) {
    const body = JSON.parse(options.body);
    if (body.tools) {
      body.tools = body.tools.map(t => {
        if (t.type === 'function' && t.function && t.function.parameters) {
          if (!t.function.parameters.type) {
            console.log(`PATCHING TOOL: ${t.function.name}`);
            t.function.parameters.type = 'object';
          }
        }
        return t;
      });
      options.body = JSON.stringify(body);
    }
  }
  return fetch(url, options);
};

const deepseek = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
  fetch: customFetch,
});

const model = deepseek.chat("deepseek-chat");

generateText({
  model,
  messages: [{role:'user',content:'hi'}],
  tools: {
    list_connections: tool({
      description: 'test tool',
      parameters: z.object({}),
      execute: async () => { console.log("executed"); }
    })
  }
}).then(r => console.log("SUCCESS:", r.text))
  .catch(e => console.error("FAILED:", e.message));
