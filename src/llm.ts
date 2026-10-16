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

// An invalid call keeps the original JSON text so the model can correct its arguments.
export interface InvalidToolCall extends Omit<ToolCall, "arguments"> {
    rawArguments: string;
    argumentError: string;
}

export interface UserMessage {
    role: "user";
    content: TextContent[];
}

export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | RefusalContent | ThinkingContent | RedactedThinkingContent | ToolCall | InvalidToolCall)[];
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
    /** The caller uses this signal to cancel the model request. */
    signal?: AbortSignal;
}

export type LlmAdapter = (request: LlmRequest) => Promise<AssistantMessage>;
export type LlmAdapters = Record<LlmApi, LlmAdapter>;

/** If the arguments fail the JSON object check, keep the tool call for an error result. */
function parseToolCall(call: Omit<ToolCall, "arguments">, argumentsJson: string): ToolCall | InvalidToolCall {
    try {
        return { ...call, arguments: parseToolArguments(call.name, argumentsJson) };
    } catch (error) {
        return { ...call, rawArguments: argumentsJson, argumentError: String(error) };
    }
}

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
            content.push(parseToolCall({
                type: "toolCall",
                id: item.call_id,
                ...(item.id === undefined ? {} : { itemId: item.id }),
                name: item.name,
            }, item.arguments));
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
                // Keep the invalid JSON text in the history without a replacement value.
                arguments: "argumentError" in block ? block.rawArguments : JSON.stringify(block.arguments),
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
        stream: true
    }, { signal: request.signal });
    // The SDK uses the signal to stop the HTTP request and the response stream.
    for await (const event of response) {
        if (event.type === "response.output_item.added") {
            switch (event.item.type) {
                case "reasoning":
                    console.log("Thinking...");
                    break;
                case "message":
                    console.log("Responding...");
                    break;
            }
        } else if (event.type === "response.reasoning_text.delta") {
            process.stdout.write(event.delta);
        } else if (event.type === "response.reasoning_text.done") {
            console.log();
        } else if (event.type === "response.output_text.delta") {
            process.stdout.write(event.delta);
        } else if (event.type === "response.output_item.done") {
            console.log();
        } else if (event.type === "error") {
            throw new Error(event.message);
        } else if (event.type === "response.completed") {
            return responseOutputToMessage(event.response.output);
        }
    }
    throw new Error("Stream ended without a completed response");
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
                        // Restore the original input value, including a value other than an object.
                        input: "argumentError" in block ? JSON.parse(block.rawArguments) : block.arguments,
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
            content.push(parseToolCall({
                type: "toolCall",
                id: block.id,
                name: block.name,
            }, JSON.stringify(block.input)));
        }
    }
    return { role: "assistant", content };
}

const anthropicMessagesAdapter: LlmAdapter = async (request) => {
    const client = new Anthropic();
    const response = client.messages.stream({
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
    }, { signal: request.signal });

    try {
        for await (const event of response) {
            if (event.type === "content_block_start") {
                switch (event.content_block.type) {
                  case "thinking":
                    console.log("Thinking...");
                    break;
                  case "text":
                    console.log("Responding...");
                    break;
                }
            } else if (event.type === "content_block_delta") {
                switch (event.delta.type) {
                  case "thinking_delta":
                    process.stdout.write(event.delta.thinking);
                    break;
                  case "text_delta":
                    process.stdout.write(event.delta.text);
                    break;
                }
            } else if (event.type === "content_block_stop") {
                console.log();
            } else if (event.type === "message_stop") {
                return anthropicMessageToMessage(await response.finalMessage());
            }
        }
    } catch (error) {
        // A user cancellation is not a model error.
        if (!request.signal?.aborted) console.error("Anthropic stream failed");
        throw error;
    }
    throw new Error("Stream ended without a completed response");
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
