/**
 * AI Model Definitions
 * Primary Provider: Google (Gemini)
 */

export type AIProvider = "google";

export interface AIModel {
  id: string;
  provider: AIProvider;
  name: string;
  description?: string;
}

/**
 * All supported AI models
 */
export const ALL_MODELS: AIModel[] = [
  {
    id: "gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash",
    description: "Ultra-fast, stable reasoning and database analysis model",
  },
  /*
  {
    id: "deepseek-chat",
    provider: "deepseek",
    name: "DeepSeek Chat",
    description: "Powerful and cost-effective chat model",
  },
  */
];

/**
 * Get list of available models
 */
export function getAvailableModels(): AIModel[] {
  return ALL_MODELS;
}

/**
 * Get a specific model by ID
 */
export function getModelById(modelId: string): AIModel | undefined {
  return ALL_MODELS.find(model => model.id === modelId);
}

/**
 * Get the default model
 */
export function getDefaultModel(): AIModel {
  return ALL_MODELS[0];
}
