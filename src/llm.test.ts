import assert from "node:assert/strict";
import test from "node:test";
import type { Message as AnthropicMessage } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Responses } from "openai/resources/responses";
import {
    anthropicMessageToMessage,
    createLlmStream,
    messageToAnthropicMessages,
    messageToResponseInput,
    responseOutputToMessage,
    type AssistantMessage,
    type Message,
    type UserMessage,
} from "./llm.ts";

const reasoningItem: Responses.ResponseReasoningItem = {
    id: "rs_1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Use bash to inspect the directory." }],
    encrypted_content: "opaque-reasoning-data",
};

const providerOutput: Responses.ResponseOutputItem[] = [
    reasoningItem,
    {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I will check the current directory.", annotations: [] }],
    },
    {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: "{\"commands\":\"pwd\"}",
        status: "completed",
    },
];

const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "Where am I?" }],
};

const openAIAssistantMessage: AssistantMessage = {
    role: "assistant",
    content: [
        {
            type: "thinking",
            thinking: "Use bash to inspect the directory.",
            thinkingSignature: JSON.stringify(reasoningItem),
            thinkingApi: "openai-responses",
        },
        { type: "text", text: "I will check the current directory." },
        {
            type: "toolCall",
            id: "call_1",
            itemId: "fc_1",
            name: "bash",
            arguments: { commands: "pwd" },
        },
    ],
};

const toolResultMessage: Message = {
    role: "tool",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text: "/workspace/shrimp" }],
};

test("canonical Agent messages become OpenAI Responses input items", () => {
    const history: Message[] = [userMessage, openAIAssistantMessage, toolResultMessage];

    assert.deepEqual(history.flatMap(messageToResponseInput), [
        { role: "user", content: [{ type: "input_text", text: "Where am I?" }] },
        reasoningItem,
        { role: "assistant", content: "I will check the current directory." },
        {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "bash",
            arguments: "{\"commands\":\"pwd\"}",
        },
        { type: "function_call_output", call_id: "call_1", output: "/workspace/shrimp" },
    ]);
});

test("a fake Responses API result becomes one canonical assistant Message", () => {
    assert.deepEqual(responseOutputToMessage(providerOutput), {
        role: "assistant",
        content: [
            {
                type: "thinking",
                thinking: "Use bash to inspect the directory.",
                thinkingSignature: JSON.stringify(reasoningItem),
                thinkingApi: "openai-responses",
            },
            { type: "text", text: "I will check the current directory." },
            {
                type: "toolCall",
                id: "call_1",
                itemId: "fc_1",
                name: "bash",
                arguments: { commands: "pwd" },
            },
        ],
    });
});

test("Anthropic history keeps thinking and groups tool results as a user message", () => {
    const history: Message[] = [
        userMessage,
        {
            role: "assistant",
            content: [
                {
                    type: "thinking",
                    thinking: "I should inspect the directory.",
                    thinkingSignature: "anthropic-signature",
                    thinkingApi: "anthropic-messages",
                },
                { type: "redactedThinking", data: "opaque-redacted-data" },
                {
                    type: "toolCall",
                    id: "call_1",
                    name: "bash",
                    arguments: { commands: "pwd" },
                },
            ],
        },
        toolResultMessage,
    ];

    assert.deepEqual(messageToAnthropicMessages(history), [
        { role: "user", content: [{ type: "text", text: "Where am I?" }] },
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "I should inspect the directory.", signature: "anthropic-signature" },
                { type: "redacted_thinking", data: "opaque-redacted-data" },
                { type: "tool_use", id: "call_1", name: "bash", input: { commands: "pwd" } },
            ],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "/workspace/shrimp" }] }],
        },
    ]);
});

test("an Anthropic response becomes one canonical assistant Message", () => {
    const response: Pick<AnthropicMessage, "content"> = {
        content: [
            { type: "thinking", thinking: "Inspect the directory.", signature: "sig_1" },
            { type: "redacted_thinking", data: "opaque-data" },
            { type: "text", text: "I will inspect it.", citations: [] },
            { type: "tool_use", id: "call_2", name: "bash", input: { commands: "pwd" }, caller: { type: "direct" } },
        ],
    };

    assert.deepEqual(anthropicMessageToMessage(response), {
        role: "assistant",
        content: [
            {
                type: "thinking",
                thinking: "Inspect the directory.",
                thinkingSignature: "sig_1",
                thinkingApi: "anthropic-messages",
            },
            { type: "redactedThinking", data: "opaque-data" },
            { type: "text", text: "I will inspect it." },
            { type: "toolCall", id: "call_2", name: "bash", arguments: { commands: "pwd" } },
        ],
    });
});

test("createLlmStream routes a fake model and returns its canonical assistant Message", async () => {
    const calls: string[] = [];
    const llmStream = createLlmStream({
        "openai-responses": async (request) => {
            calls.push("openai-responses");
            assert.deepEqual(request.messages, [userMessage]);
            return responseOutputToMessage(providerOutput);
        },
        "anthropic-messages": async () => {
            calls.push("anthropic-messages");
            throw new Error("wrong adapter selected");
        },
    });

    const reply = await llmStream({
        model: { api: "openai-responses", model: "fake-model" },
        messages: [userMessage],
    });

    assert.deepEqual(calls, ["openai-responses"]);
    assert.deepEqual(reply, responseOutputToMessage(providerOutput));
});
