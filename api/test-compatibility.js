require('dotenv').config({ path: '../.env' });
const { createOpenAI } = require('@ai-sdk/openai');
const { generateText, tool } = require('ai');
const { z } = require('zod');

const deepseek = createOpenAI({ 
  apiKey: process.env.DEEPSEEK_API_KEY, 
  baseURL: 'https://api.deepseek.com',
  compatibility: 'compatible' // Disables OpenAI-specific strict structured outputs
});

generateText({
  model: deepseek.chat('deepseek-chat'),
  messages: [{role:'user',content:'hi'}],
  tools: {
    list_connections: tool({
      description: 'test',
      parameters: z.object({ _dummy: z.string().describe('test') }),
      execute: async()=>{}
    })
  }
}).then(r => console.log('SUCCESS'))
  .catch(e => console.error(e.message));
