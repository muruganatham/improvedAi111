require('dotenv').config({ path: '../.env' });
const { createDeepSeek } = require('@ai-sdk/deepseek');
const { generateText, tool } = require('ai');
const { z } = require('zod');

const customFetch = async (url, options) => {
  const body = JSON.parse(options.body);
  console.log("---- TOOLS SENT TO DEEPSEEK ----");
  console.dir(body.tools, { depth: null });
  console.log("--------------------------------");
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({
      id: "abc", object: "chat.completion", created: 123, model: "deepseek-chat",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {}
    }),
    text: async () => "{}"
  };
};

const deepseek = createDeepSeek({ 
  apiKey: "dummy", 
  fetch: customFetch
});

generateText({
  model: deepseek('deepseek-chat'),
  messages: [{role:'user',content:'hi'}],
  tools: {
    list_connections: tool({
      description: 'test',
      parameters: z.object({ a: z.string(), b: z.number() }),
      execute: async(args)=>{}
    })
  }
}).then(r => console.log('SUCCESS'))
  .catch(e => console.error(e.message));
