import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Responses } from "openai/resources/responses";
import type { Message as AnthropicMessage, MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ToolDefinition } from "./tools.ts";
import { parseToolArguments } from "./tools.ts";

export type LlmApi = "openai-responses" | "anthropic-messages";

export interface ModelConfig {
    api: LlmApi;
    model: string;
    maxOutputTokens?: number;
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

export interface UserMessage {
    role: "user";
    content: TextContent[];
}

export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | RefusalContent | ThinkingContent | RedactedThinkingContent | ToolCall)[];
}

export interface ToolResultMessage {
    role: "tool";
    toolCallId: string;
    toolName: string;
    content: TextContent[];
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface LlmRequest {
    model: ModelConfig;
    messages: Message[];
    systemPrompt?: string;
    tools?: ToolDefinition[];
}

export type LlmAdapter = (request: LlmRequest) => Promise<AssistantMessage>;
export type LlmAdapters = Record<LlmApi, LlmAdapter>;

export function responseOutputToMessage(
    output: Responses.ResponseOutputItem[],
): AssistantMessage {
    const content: AssistantMessage["content"] = [];

    for (const item of output) {
        if (item.type === "reasoning") {
            const thinking = [
                ...(item.summary?.map((part) => part.text) ?? []),
                ...(item.content?.map((part) => part.text) ?? []),
            ].join("\n\n");
            content.push({
                type: "thinking",
                thinking,
                thinkingSignature: JSON.stringify(item),
                thinkingApi: "openai-responses",
            });
        } else if (item.type === "message") {
            for (const block of item.content) {
                if (block.type === "output_text") {
                    content.push({ type: "text", text: block.text });
                } else if (block.type === "refusal") {
                    content.push({ type: "refusal", refusal: block.refusal });
                }
            }
        } else if (item.type === "function_call") {
            content.push({
                type: "toolCall",
                id: item.call_id,
                ...(item.id === undefined ? {} : { itemId: item.id }),
                name: item.name,
                arguments: parseToolArguments(item.name, item.arguments),
            });
        }
    }

    return { role: "assistant", content };
}

export function messageToResponseInput(message: Message): Responses.ResponseInputItem[] {
    if (message.role === "user") {
        return [{
            role: "user",
            content: message.content.map((block) => ({ type: "input_text", text: block.text })),
        }];
    }

    if (message.role === "tool") {
        return [{
            type: "function_call_output",
            call_id: message.toolCallId,
            output: message.content.map((block) => block.text).join("\n"),
        }];
    }

    const input: Responses.ResponseInputItem[] = [];
    for (const block of message.content) {
        if (block.type === "text") {
            input.push({ role: "assistant", content: block.text });
        } else if (block.type === "refusal") {
            input.push({ role: "assistant", content: block.refusal });
        } else if (block.type === "thinking" && block.thinkingApi === "openai-responses") {
            if (!block.thinkingSignature) {
                throw new Error("Missing OpenAI Responses reasoning signature");
            }
            const reasoning: unknown = JSON.parse(block.thinkingSignature);
            if (typeof reasoning !== "object" || reasoning === null || !("type" in reasoning) || reasoning.type !== "reasoning") {
                throw new Error("Invalid OpenAI Responses reasoning signature");
            }
            input.push(reasoning as Responses.ResponseReasoningItem);
        } else if (block.type === "toolCall") {
            input.push({
                type: "function_call",
                ...(block.itemId === undefined ? {} : { id: block.itemId }),
                call_id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.arguments),
            });
        }
    }
    return input;
}

function toOpenAITools(tools: ToolDefinition[] | undefined): Responses.Tool[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
    }));
}

const openAIResponsesAdapter: LlmAdapter = async (request) => {
    const client = new OpenAI();
    const response = await client.responses.create({
        model: request.model.model,
        ...(request.model.maxOutputTokens === undefined ? {} : { max_output_tokens: request.model.maxOutputTokens }),
        ...(request.systemPrompt === undefined ? {} : { instructions: request.systemPrompt }),
        input: request.messages.flatMap(messageToResponseInput),
        tools: toOpenAITools(request.tools),
    });
    return responseOutputToMessage(response.output);
};

export function messageToAnthropicMessages(messages: Message[]): MessageParam[] {
    const result: MessageParam[] = [];

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === "user") {
            result.push({ role: "user", content: message.content.map(({ text }) => ({ type: "text", text })) });
        } else if (message.role === "tool") {
            const results = [];
            while (index < messages.length && messages[index]?.role === "tool") {
                const toolResult = messages[index++];
                if (toolResult?.role !== "tool") continue;
                results.push({
                    type: "tool_result" as const,
                    tool_use_id: toolResult.toolCallId,
                    content: toolResult.content.map(({ text }) => ({ type: "text" as const, text })),
                });
            }
            index--;
            result.push({ role: "user", content: results });
        } else {
            const content = [];
            for (const block of message.content) {
                if (block.type === "text") {
                    content.push({ type: "text" as const, text: block.text });
                } else if (block.type === "refusal") {
                    content.push({ type: "text" as const, text: block.refusal });
                } else if (block.type === "thinking" && block.thinkingApi === "anthropic-messages" && block.thinkingSignature) {
                    content.push({
                        type: "thinking" as const,
                        thinking: block.thinking,
                        signature: block.thinkingSignature,
                    });
                } else if (block.type === "redactedThinking") {
                    content.push({ type: "redacted_thinking" as const, data: block.data });
                } else if (block.type === "toolCall") {
                    content.push({
                        type: "tool_use" as const,
                        id: block.id,
                        name: block.name,
                        input: block.arguments,
                    });
                }
            }
            if (content.length > 0) {
                result.push({ role: "assistant", content });
            }
        }
    }

    return result;
}

export function anthropicMessageToMessage(
    response: Pick<AnthropicMessage, "content">,
): AssistantMessage {
    const content: AssistantMessage["content"] = [];
    for (const block of response.content) {
        if (block.type === "text") {
            content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
            content.push({
                type: "thinking",
                thinking: block.thinking,
                thinkingSignature: block.signature,
                thinkingApi: "anthropic-messages",
            });
        } else if (block.type === "redacted_thinking") {
            content.push({ type: "redactedThinking", data: block.data });
        } else if (block.type === "tool_use") {
            content.push({
                type: "toolCall",
                id: block.id,
                name: block.name,
                arguments: parseToolArguments(block.name, JSON.stringify(block.input)),
            });
        }
    }
    return { role: "assistant", content };
}

const anthropicMessagesAdapter: LlmAdapter = async (request) => {
    const client = new Anthropic();
    const response = await client.messages.create({
        model: request.model.model,
        max_tokens: request.model.maxOutputTokens ?? 4096,
        messages: messageToAnthropicMessages(request.messages),
        ...(request.systemPrompt === undefined ? {} : { system: request.systemPrompt }),
        ...(request.tools?.length ? {
            tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
            })),
        } : {}),
    });
    return anthropicMessageToMessage(response);
};

export const LLM_ADAPTERS: LlmAdapters = {
    "openai-responses": openAIResponsesAdapter,
    "anthropic-messages": anthropicMessagesAdapter,
};

export function createLlmStream(adapters: LlmAdapters = LLM_ADAPTERS) {
    return (request: LlmRequest): Promise<AssistantMessage> => {
        const adapter = adapters[request.model.api];
        if (typeof adapter !== "function") {
            throw new Error(`No LLM adapter registered for API: ${request.model.api}`);
        }
        return adapter(request);
    };
}

export const llmStream = createLlmStream();
