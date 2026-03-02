import type { UIMessage } from "ai";

/**
 * Sanitize UIMessages by removing incomplete tool parts.
 *
 * When a chat stream is interrupted (user closes browser, network failure, etc.),
 * tool parts may be saved to the database in an incomplete state (e.g., "input-available",
 * "input-streaming") without a corresponding result. When the user resumes the chat,
 * these malformed messages would cause Anthropic API errors:
 *
 *   "tool_use ids were found without tool_result blocks immediately after"
 */
/**
 * Strip common narration patterns from assistant messages.
 * This prevents the model from seeing its own "wordy" history and repeating it.
 */
function stripNarration(text: string): string {
  const patterns = [
    /^(I've|I have) (already|just) .*?(\n|\.|$)/is,
    /^(Sure,? )?(I'll|I will) help you (analyze|with|find).*?(\n|\.|$)/is,
    /^(Let me|I'll|I will) (check|examine|explore|inspect|now).*?(\n|\.|$)/is,
    /^(First|Next|Now),? (I'll|I'll begin by|I will).*?(\n|\.|$)/is,
    /^I (can)? see (that|you have).*?(\n|\.|$)/is,
    /^Looking at (the|your).*?(\n|\.|$)/is,
    /^I (found|have found).*?(\n|\.|$)/is,
    /^Checking (tables|databases|collections).*?(\n|\.|$)/is,
    /^Search results for.*?(\n|\.|$)/is,
    /^Searching (for|among).*?(\n|\.|$)/is,
    /^Executing (query|SQL).*?(\n|\.|$)/is,
    /^Found (result|data|match).*?(\n|\.|$)/is,
    /^The results (are|show).*?(\n|\.|$)/is,
    /^I've placed (the|your) query.*?(\n|\.|$)/is,
    /^Here is (the|your) query.*?(\n|\.|$)/is,
    /^(Based on|Regarding|In response to).*?(\n|\.|$)/is,
    /^(Would you like|Please let me|To summarize|In summary).*?(\n|\.|$)/is,
    /^(Step \d+|Total \d+).*?(\n|\.|$)/is,
    /\b(console(?!s)|workspace)\b/gi,
  ];

  let sanitized = text;
  patterns.forEach(p => {
    sanitized = sanitized.replace(p, "");
  });

  return sanitized.trim();
}


/**
 * Sanitize UIMessages by removing incomplete tool parts and wordy narration.
 */
export function sanitizeMessagesForModel(messages: UIMessage[]): UIMessage[] {
  return messages.map(msg => {
    // Only assistant messages can have tool parts or narration
    if (msg.role !== "assistant") {
      return msg;
    }

    // If no parts, nothing to sanitize
    if (!msg.parts || msg.parts.length === 0) {
      return msg;
    }

    const sanitizedParts = msg.parts
      .filter(part => {
        const partType = part.type;

        // Keep all non-tool parts (text, reasoning, etc.)
        if (
          typeof partType !== "string" ||
          (!partType.startsWith("tool-") && partType !== "dynamic-tool")
        ) {
          return true;
        }

        // For tool parts, only keep those with complete states
        const state = (part as Record<string, unknown>).state as
          | string
          | undefined;

        return state === "output-available" || state === "error";
      })
      .map(part => {
        // Strip narration from text parts
        if (part.type === "text") {
          return { ...part, text: stripNarration(part.text) };
        }
        return part;
      });

    // If all parts were filtered out, return a minimal message to preserve structure
    // This prevents empty assistant messages which could confuse the model
    if (sanitizedParts.length === 0) {
      return {
        ...msg,
        parts: [{ type: "text" as const, text: "[Response interrupted]" }],
      };
    }

    // If nothing changed, return original to preserve object identity
    // This check is removed because `map` might change content even if length is the same.
    // The new logic always creates a new object if `sanitizedParts` is different from `msg.parts`
    // or if any text part was modified by `stripNarration`.
    // A more robust check would involve deep comparison, but for simplicity,
    // we'll just return a new object if `sanitizedParts` is different.
    // If the original `msg.parts` and `sanitizedParts` are identical in content and order,
    // then the `map` operation on `messages` will still create a new message object,
    // but its `parts` array might be the same reference if no parts were modified.
    // For now, we'll just return the new object.

    return { ...msg, parts: sanitizedParts };
  });
}
