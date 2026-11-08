import type { Message } from "../domain/agent.ts";
import type { ModelConfig } from "../adapter/llm.ts";
import type { ToolDefinition } from "../domain/tools.ts";

export function contextInject(query: string, context: string): string {
    return context + "\n" + query
}

export interface Context {
	model: ModelConfig;
	systemPrompt?: string;
	messages: Message[];
	tools?: ToolDefinition[];
}
