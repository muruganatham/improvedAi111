require('dotenv').config({ path: '../.env' });
const { createDeepSeek } = require('@ai-sdk/deepseek');
const { generateText, tool } = require('ai');
const { z } = require('zod');

const deepseek = createDeepSeek({ 
  apiKey: process.env.DEEPSEEK_API_KEY, 
});

generateText({
  model: deepseek('deepseek-chat'),
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
