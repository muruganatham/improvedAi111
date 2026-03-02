require('dotenv').config({ path: '../.env' });
const { createOpenAI } = require('@ai-sdk/openai');
const { generateText, tool } = require('ai');
const { z } = require('zod');

const customFetch = async (url, options) => {
  console.log("==== OUTGOING PAYLOAD ====");
  console.log(JSON.stringify(JSON.parse(options.body), null, 2));
  console.log("==========================");
  throw new Error("ABORT_ON_SUCCESS");
};

const deepseek = createOpenAI({ 
  apiKey: process.env.DEEPSEEK_API_KEY, 
  baseURL: 'https://api.deepseek.com',
  fetch: customFetch
});

generateText({
  model: deepseek.chat('deepseek-chat'),
  messages: [{role:'user',content:'hi'}],
  tools: {
    list_connections: tool({
      description: 'test',
      parameters: z.object({ a: z.string().describe('test') }),
      execute: async()=>{}
    })
  }
}).then(() => console.log("SUCCESS")).catch(e => console.error(e.message));
