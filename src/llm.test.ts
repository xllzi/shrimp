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

test("OpenAI tool calls keep invalid arguments and valid calls in the same response", () => {
    for (const argumentsJson of [' {"commands": ', "[]", "null", '"pwd"', "42", "true"]) {
        const invalid: Responses.ResponseFunctionToolCall = {
            type: "function_call",
            id: "fc_invalid",
            call_id: "call_invalid",
            name: "bash",
            arguments: argumentsJson,
            status: "completed",
        };
        const message = responseOutputToMessage([invalid, providerOutput[2]!]);
        const call = message.content[0];
        assert.ok(call?.type === "toolCall" && "argumentError" in call);
        assert.equal(call.id, invalid.call_id);
        assert.equal(call.name, invalid.name);
        assert.equal(call.rawArguments, argumentsJson);
        assert.match(call.argumentError, /Invalid (JSON )?arguments for bash/);
        assert.equal("arguments" in call, false);
        assert.deepEqual(message.content[1], openAIAssistantMessage.content[2]);
        assert.deepEqual(messageToResponseInput(message)[0], {
            type: "function_call",
            id: invalid.id,
            call_id: invalid.call_id,
            name: invalid.name,
            arguments: argumentsJson,
        });
    }
});

test("Anthropic tool calls keep input values other than objects in the history", () => {
    for (const input of [[], null, "pwd", 42, true]) {
        const block = { type: "tool_use" as const, id: "call_invalid", name: "bash", input, caller: { type: "direct" as const } };
        const message = anthropicMessageToMessage({ content: [block] });
        const call = message.content[0];
        assert.ok(call?.type === "toolCall" && "argumentError" in call);
        assert.equal(call.id, block.id);
        assert.equal(call.name, block.name);
        assert.equal(call.rawArguments, JSON.stringify(input));
        assert.match(call.argumentError, /Invalid arguments for bash/);
        assert.equal("arguments" in call, false);
        assert.deepEqual(messageToAnthropicMessages([message]), [{
            role: "assistant",
            content: [{ type: "tool_use", id: block.id, name: block.name, input }],
        }]);
    }
});

test("the message converter leaves tool field checks to the tool handler", () => {
    const message = responseOutputToMessage([{
        type: "function_call",
        call_id: "call_fields",
        name: "read_file",
        arguments: '{"filePath":123}',
    }]);
    assert.deepEqual(message.content, [{
        type: "toolCall",
        id: "call_fields",
        name: "read_file",
        arguments: { filePath: 123 },
    }]);
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
