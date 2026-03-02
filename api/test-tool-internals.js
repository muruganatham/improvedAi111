const { generateText, tool } = require('ai');
const { z } = require('zod');

const deepseek = {
  chat: () => ({
    specificationVersion: 'v3',
    provider: "custom",
    modelId: "mock",
    defaultObjectGenerationMode: "json",
    doGenerate: async (args) => {
      console.log("---- RAW TOOLS ----");
      console.dir(args.tools, { depth: null });
      return {text: 'hi', finishReason: 'stop', usage: {promptTokens: 0, completionTokens: 0}, warnings: []};
    }
  })
};

generateText({
  model: deepseek.chat(),
  messages: [{role:'user',content:'hi'}],
  tools: {
    t1: tool({
      description: 'test',
      parameters: z.object({ a: z.string() }),
      execute: async ({ a }) => { console.log(a); } // Use it!
    })
  }
}).catch(console.error);
