// ════════════════════════════════════════════════════════════════
// FILE: api/src/agent-lib/question-classifier.ts
// ════════════════════════════════════════════════════════════════

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { loggers } from "../logging";

const logger = loggers.agent();

// Configure DeepSeek provider
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

const deepseekProvider = createOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com",
    fetch: patchedFetch as any,
});

export type QuestionScope = "public" | "personal" | "restricted";

export interface ClassificationResult {
    route: "db" | "general" | "greeting";
    scope: QuestionScope;
    reason: string;
    tables_hint: string[];
    usage?: { promptTokens: number; completionTokens: number };
}

const CLASSIFIER_SYSTEM_PROMPT = `You are the Security Router for an educational database.
Your job is to analyze the user's question, their role, and determine two things: ROUTE and SCOPE.

ROUTE OPTIONS:
- "greeting": Only for simple hellos (hi, hello, etc.)
- "general": For coding concepts, advice, or system architecture (e.g., "what is java", "how to improve", "how does amypo work"). No DB needed.
- "db": For ANY data lookup, reports, test scores, counts, placements, profile lookup, or table data.

SCOPE OPTIONS (Crucial for Security):
- "personal": The user is asking about THEIR OWN data. (e.g., "my score", "how many did I solve", "who am I").
- "public": Asking about catalog/general platform info WITH NO SPECIFIC USER ATTACHED. (e.g., "how many courses exist", "list colleges").
- "restricted": Asking about OTHER PEOPLE'S data, comparing users, ranking, asking for passwords, or counting students. Examples: "top 10 students", "who is Karthick", "compare my score with Ravi", "show me all passwords".

RANK/POSITION RULES (important!):
- "my rank" / "what is my rank" / "where do I stand" / "my position" = PERSONAL
  (student asking about their OWN rank in course_wise_segregations)
- "top 10 students" / "rank all students" / "leaderboard" / "class topper" = RESTRICTED
  (asking to see OTHER students' rankings)
- KEY SIGNAL: "my" + rank/position = ALWAYS personal. Even with course name.
  Example: "my rank in Data Structures" = PERSONAL (not restricted!)

COMPARISON RULES:
- "compare my score with [name]" / "my vs [name]" = RESTRICTED
  (involves ANOTHER person's data)
- "compare my two courses" (no other person) = PERSONAL

PLACEMENT RULES:
- Any question about placements, interviews, career prep = route to "general"
  (no placement data exists in DB)

MARKETPLACE / B2C RULES:
- "marketplace courses" / "B2C courses" / "free courses" / "available courses on portal" / "courses in marketplace"
  → route: "db", scope: "public", tables_hint: ["course_academic_maps", "courses", "languages"]
- "how many marketplace courses" / "list free courses" / "marketplace course details"
  → route: "db", scope: "public", tables_hint: ["course_academic_maps", "courses"]
- "marketplace enrollments" / "how many enrolled in marketplace" / "B2C students"
  → route: "db", scope: "public", tables_hint: ["course_academic_maps", "courses", "user_course_enrollments"]
- "my marketplace progress" / "my B2C results" / "my free course scores"
  → route: "db", scope: "personal", tables_hint: ["b2c_test_data", "b2c_coding_result", "b2c_mcq_result"]
- KEY: Marketplace = course_academic_maps where college_id, department_id, batch_id, section_id are ALL NULL.
  Do NOT confuse with regular college-allocated courses.

TABLES HINT:
If route="db", provide a list of 1-3 table names that contain the answer.
Available core tables: users, user_academics, colleges, departments, batches, sections, courses, course_academic_maps, course_wise_segregations, user_course_enrollments.
Dynamic table prefixes: coding_result, mcq_result, test_data.

OUTPUT FORMAT:
Generate ONLY a valid JSON object matching this schema. No markdown wrapping.
{
  "route": "db" | "general" | "greeting",
  "scope": "public" | "personal" | "restricted",
  "reason": "Short explanation of your choice",
  "tables_hint": ["table1", "table2"]
}`;

export async function classifyQuestion(question: string, roleNum: number, roleName: string): Promise<ClassificationResult> {
    const q = question.trim();

    // SUPER FAST PATH FOR GREETINGS
    if (/^(hi|hello|hey|greetings)[^a-z0-9]*$/i.test(q)) {
        return { route: "greeting", scope: "public", reason: "simple greeting", tables_hint: [], usage: { promptTokens: 0, completionTokens: 0 } };
    }

    // SUPER FAST PATH FOR PURE IDENTITY
    if (/^\s*(who\s+am\s+i|who\s+i\s+am|my\s+profile)\s*\??\s*$/i.test(q)) {
        return { route: "db", scope: "personal", reason: "identity", tables_hint: ["users", "user_academics"], usage: { promptTokens: 0, completionTokens: 0 } };
    }

    try {
        const { text, usage } = await generateText({
            model: deepseekProvider.chat("deepseek-chat"),
            system: CLASSIFIER_SYSTEM_PROMPT,
            messages: [
                { role: "user", content: `User Role: ${roleNum} (${roleName})\nQuestion: "${q}"` }
            ],
            temperature: 0,
            maxOutputTokens: 250,
        });

        const cleanedText = text.replace(/^\s*\`\`\`(json)?/, "").replace(/\`\`\`\s*$/, "").trim();
        const parsed = JSON.parse(cleanedText) as ClassificationResult;
        parsed.usage = { promptTokens: (usage as any)?.inputTokens || 0, completionTokens: (usage as any)?.outputTokens || 0 };

        logger.info("[LLM-Classifier]", { result: parsed });

        // Safety fallback: if personal data is asked but wasn't caught
        if (parsed.scope === "public" && /\b(my|i|me|myself)\b/i.test(q)) {
            parsed.scope = "personal";
            parsed.reason = "fallback to personal due to self-reference";
        }

        return parsed;

    } catch (error: any) {
        logger.error("[LLM-Classifier] Failed, falling back to safe defaults", { error: error.message });
        // Failsafe: if the LLM fails, assume it's a DB query for personal data (safest possible combination)
        return {
            route: "db",
            scope: "personal",
            reason: "fallback default",
            tables_hint: [],
            usage: { promptTokens: 0, completionTokens: 0 }
        };
    }
}
