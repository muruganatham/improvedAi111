const { generateText, tool } = require('ai');
const { z } = require('zod');
const { createOpenAI } = require('@ai-sdk/openai');

async function main() {
    const patchedFetch = async (url, options) => {
        if (options?.body) {
            try {
                const body = JSON.parse(options.body);
                if (Array.isArray(body.tools)) {
                    body.tools = body.tools.map(t => {
                        if (t.type === 'function' && t.function?.parameters && !t.function.parameters.type) {
                            t.function.parameters.type = 'object';
                        }
                        return t;
                    });
                    options.body = JSON.stringify(body);
                }
            } catch { }
        }
        return fetch(url, options);
    };

    const provider = createOpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com',
        fetch: patchedFetch,
    });
    const model = provider.chat('deepseek-chat');

    const tools = {
        get_info: tool({
            description: 'Get some info',
            parameters: z.object({ query: z.string().describe('query') }),
            execute: async ({ query }) => ({ answer: 'The info is 42', query }),
        }),
    };

    console.log('=== CALLING generateText with tools ===');
    const result = await generateText({
        model,
        system: 'You are helpful. If asked a question, always call get_info tool first.',
        messages: [{ role: 'user', content: 'What is the meaning of life?' }],
        tools,
        temperature: 0.1,
    });

    console.log('\n=== RESULT TOP-LEVEL KEYS ===');
    console.log(Object.keys(result));

    console.log('\n=== toolCalls ===');
    if (result.toolCalls?.length) {
        for (const tc of result.toolCalls) {
            console.log('keys:', Object.keys(tc));
            console.log('full:', JSON.stringify(tc, null, 2));
        }
    } else {
        console.log('NONE');
    }

    console.log('\n=== toolResults ===');
    if (result.toolResults?.length) {
        for (const tr of result.toolResults) {
            console.log('keys:', Object.keys(tr));
            console.log('full:', JSON.stringify(tr, null, 2));
        }
    } else {
        console.log('NONE');
    }

    console.log('\n=== response ===');
    if (result.response) {
        console.log('response keys:', Object.keys(result.response));
        if (result.response.messages) {
            console.log('response.messages length:', result.response.messages.length);
            for (const m of result.response.messages) {
                console.log('\n--- message ---');
                console.log('keys:', Object.keys(m));
                console.log(JSON.stringify(m, null, 2).slice(0, 500));
            }
        }
    }

    console.log('\n=== responseMessages (legacy?) ===');
    console.log(result.responseMessages ? 'EXISTS' : 'NONE');
    if (result.responseMessages) {
        for (const m of result.responseMessages) {
            console.log(JSON.stringify(m, null, 2).slice(0, 500));
        }
    }

    console.log('\n=== text ===');
    console.log(result.text?.slice(0, 300) || 'EMPTY');
}

main().catch(e => console.error(e.message));
