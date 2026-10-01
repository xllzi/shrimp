import type { Message, ModelConfig } from "./llm.ts";
import type { ToolDefinition } from "./tools.ts";

export function contextInject(query: string, context: string): string {
    return context + "\n" + query
}

export interface Context {
	model: ModelConfig;
	systemPrompt?: string;
	messages: Message[];
	tools?: ToolDefinition[];
}
