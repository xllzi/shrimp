import type { LlmApi } from "../adapter/llm.ts";

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage {
    role: "user";
    content: TextContent[];
}

export interface Usage {
    input_tokens: number,
    output_tokens: number,
    cache_read_tokens: number,
}

export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | RefusalContent | ThinkingContent | RedactedThinkingContent | ToolCall | InvalidToolCall)[];
    usage: Usage; // Usage for the model request that produced this message.
}

export interface TextContent {
    type: "text";
    text: string;
}

export interface RefusalContent {
    type: "refusal";
    refusal: string;
}

export interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    thinkingApi?: LlmApi;
}

export interface RedactedThinkingContent {
    type: "redactedThinking";
    data: string;
}

export interface ToolCall {
    type: "toolCall";
    id: string;
    itemId?: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface ToolResultMessage {
    role: "tool";
    toolCallId: string;
    toolName: string;
    content: TextContent[];
}

// An invalid call keeps the original JSON text so the model can correct its arguments.
export interface InvalidToolCall extends Omit<ToolCall, "arguments"> {
    rawArguments: string;
    argumentError: string;
}

export type State = {
    messages: Message[],
    readFileHashes: Map<string, string>,
    loopCount: number,
    usage: Usage, // Token totals for this state. Each new user prompt uses the same state.
}
