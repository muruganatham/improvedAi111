import { generateText, tool } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';

const patchedFetch = async (url: string, options: any) => {
    if (options?.body) {
        try {
            const body = JSON.parse(options.body);
            if (Array.isArray(body.tools)) {
                body.tools = body.tools.map((t: any) => {
                    if (t.type === "function" && t.function?.parameters && !t.function.parameters.type) {
                        t.function.parameters.type = "object";
                    }
                    return t;
                });
                options.body = JSON.stringify(body);
            }
        } catch { /* not JSON */ }
    }
    return fetch(url, options);
};

const openai = createOpenAI({
    apiKey: "sk-1d68cf138023472b828ede281a46ddab",
    baseURL: "https://api.deepseek.com",
    fetch: patchedFetch as any
});

const model = openai.chat("deepseek-chat");

async function main() {
    console.log("Starting test...");
    try {
        const result = await generateText({
            model,
            system: "You are a database assistant. First list tables. Then describe a table like 'users'. You MUST call tools.",
            messages: [{ role: "user", content: "Tell me about the users table." }],
            tools: {
                list_tables: tool({
                    description: "List all tables",
                    parameters: z.object({ _unused: z.string().optional() }),
                    execute: async () => {
                        console.log("-> list_tables executed");
                        return { tables: ["users", "courses"] };
                    }
                }),
                describe_table: tool({
                    description: "Describe a table",
                    parameters: z.object({ table_name: z.string() }),
                    execute: async ({ table_name }) => {
                        console.log("-> describe_table executed with:", table_name);
                        return { columns: ["id", "name"] };
                    }
                })
            },
            maxSteps: 4,
            onStepFinish: (step) => {
                console.log("STEP FINISH TOOL CALLS:", JSON.stringify(step.toolCalls, null, 2));
                console.log("STEP FINISH TOOL RESULTS:", JSON.stringify(step.toolResults, null, 2));
            }
        });

        console.log("FINAL TEXT:", result.text);
    } catch (err: any) {
        console.error("SDK Error:", err.message);
    }
}

main().catch(console.error);
