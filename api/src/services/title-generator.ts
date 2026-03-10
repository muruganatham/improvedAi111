/**
 * Title Generation Service
 * Uses AI SDK generateText for simple, fast title generation
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { loggers } from "../logging";

const logger = loggers.agent();

/*
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
    } catch { }
  }
  return fetch(url, options);
};

const deepseekProvider = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
  fetch: patchedFetch as any,
});
*/

import { createGoogleGenerativeAI } from "@ai-sdk/google";
const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_AI_API_KEY,
});

const TITLE_SYSTEM_PROMPT = `You are a title generator. Generate a concise 3-8 word title for a chat conversation.

Rules:
- Be specific and descriptive
- Use noun phrases that capture the main topic or task
- Avoid generic phrases like "Conversation", "Chat", "Question", "Help", "Assistance"
- Focus on the core subject matter or goal
- Examples: "Sales Revenue Analysis", "Customer Churn Prediction", "MongoDB Query Optimization"

Return only the title, nothing else.`;

/**
 * Extract text content from a message (handles both v2 .content and v6 .parts formats)
 */
const getMessageContent = (message: any): string => {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }

  return "";
};

/**
 * Generate a title from the first user message content
 * Simple and fast - just needs the user's initial message
 */
export const generateChatTitle = async (
  userMessageContent: string,
): Promise<string> => {
  try {
    const { text } = await generateText({
      model: google("gemini-2.5-flash"), // Transitioned from deepseek-chat
      system: TITLE_SYSTEM_PROMPT,
      prompt: userMessageContent.substring(0, 2000), // Limit input length
    });

    let title = text.trim();
    title = title.replace(/^["']|["']$/g, ""); // Remove quotes
    title = title.substring(0, 80); // Character limit

    // Fallback if title is too short or empty
    if (title.length < 3) {
      return "New Conversation";
    }

    return title;
  } catch (error) {
    logger.error("Title generation failed", { error });
    return "New Conversation";
  }
};

/**
 * Legacy function for backward compatibility with existing code
 * Extracts first user message and generates title
 */
export const generateChatTitleFromMessages = async (
  messages: any[],
): Promise<string> => {
  const firstUserMessage = messages.find(m => m.role === "user");
  if (!firstUserMessage) {
    return "New Conversation";
  }

  const content = getMessageContent(firstUserMessage);
  if (!content || content.trim().length < 3) {
    return "New Conversation";
  }

  return generateChatTitle(content);
};

/**
 * Check if we should generate a title (for backward compatibility)
 * Now simplified: generate if there's at least one user message with content
 */
export const shouldGenerateTitle = (messages: any[]): boolean => {
  const firstUserMessage = messages.find(m => m.role === "user");
  if (!firstUserMessage) return false;

  const content = getMessageContent(firstUserMessage);
  return content.trim().length >= 3;
};
