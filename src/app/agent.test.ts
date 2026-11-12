import { parseBash } from "../adapter/bash.ts";
import { createPermissionCheck } from "./permission.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { messageToResponseInput, LLM_ADAPTERS, type LlmApi, type LlmRequest, type ModelTextEvent, responseOutputToMessage } from "../adapter/llm.ts";
import type { AssistantMessage, Message, State } from "../domain/agent.ts";
import { onPostToolUse, onPreToolUse } from "./hooks.ts";
import { TOOL_HANDLERS, type ToolFn } from "./tools.ts";
import { agentLoop as runAgentLoop, type AgentOutputEvent } from "./agent.ts";
import type { TraceEvent } from "./trace.ts";

const permissionCheck = createPermissionCheck({
    workspace: process.cwd(),
    parseBash,
    askPermission: async () => { throw new Error("Unexpected approval prompt in agent test"); },
});

function agentLoop(state: State, signal?: AbortSignal) {
    return runAgentLoop(state, permissionCheck, signal);
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function history(): Message[] {
    return [{ role: "user", content: [{ type: "text", text: "Test the request." }] }];
}

const reply: AssistantMessage = {
    role: "assistant", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
    content: [{ type: "text", text: "Done." }],
};

test("a model error returns its cause without an assistant message", async (t) => {
    const messages = history();
    const events: TraceEvent[] = [];
    const error = new Error("Test request failed.");
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async () => { throw error; });

    const state = { messages, loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    assert.deepEqual(await runAgentLoop(state, permissionCheck, undefined, event => events.push(event)), { stop_reason: "model_error", error });
    assert.equal(messages.length, 1);
    assert.deepEqual(events.map(event => event.type), ["run.started", "model.started", "model.finished", "run.finished"]);
    assert.deepEqual(events.flatMap(event => event.type === "model.finished" ? [event.status, event.usage] : []), ["error", undefined]);
    assert.deepEqual(events.flatMap(event => event.type === "run.finished" ? [event.stop_reason] : []), ["model_error"]);
});

test("the model can correct invalid JSON while valid calls in the same response still run", async (t) => {
    const messages = history();
    const invalidJson = '{"commands":';
    const first = responseOutputToMessage([
        { type: "function_call", call_id: "invalid", name: "bash", arguments: invalidJson },
        { type: "function_call", call_id: "non_object", name: "bash", arguments: "[]" },
        { type: "function_call", call_id: "valid", name: "read_file", arguments: '{"filePath":"sibling"}' },
    ]);
    const corrected = responseOutputToMessage([
        { type: "function_call", call_id: "corrected", name: "bash", arguments: '{"commands":"pwd"}' },
    ]);
    let requests = 0;
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (request: LlmRequest) => {
        requests++;
        if (requests === 1) return first;
        if (requests === 2) {
            const results = request.messages.slice(2);
            assert.equal(results.length, 3);
            for (const [index, id] of ["invalid", "non_object"].entries()) {
                const result = results[index];
                assert.ok(result?.role === "tool");
                assert.equal(result.toolCallId, id);
                assert.match(result.content[0]!.text, /Invalid (JSON )?arguments for bash/);
            }
            assert.deepEqual(results[2], {
                role: "tool", toolCallId: "valid", toolName: "read_file",
                content: [{ type: "text", text: "The sibling tool completed." }],
            });
            const replay = request.messages.flatMap(messageToResponseInput);
            assert.ok(replay.some(item => item.type === "function_call" && item.call_id === "invalid" && item.arguments === invalidJson));
            return corrected;
        }
        assert.equal(requests, 3);
        assert.deepEqual(request.messages.at(-1), {
            role: "tool", toolCallId: "corrected", toolName: "bash",
            content: [{ type: "text", text: "The corrected tool completed." }],
        });
        return reply;
    });
    const read = t.mock.method(TOOL_HANDLERS, "read_file", async () => "The sibling tool completed.");
    const bash = t.mock.method(TOOL_HANDLERS, "bash", async (..._args: Parameters<ToolFn>) => "The corrected tool completed.");

    const state = { messages, loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    assert.deepEqual(await agentLoop(state), { stop_reason: "completed", message: reply });
    assert.equal(requests, 3);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(bash.mock.callCount(), 1);
    assert.deepEqual(bash.mock.calls[0]!.arguments, [{ commands: "pwd" }, state, undefined]);
    assert.equal(bash.mock.calls[0]!.arguments[1], state);
});

test("a cancelled signal prevents a model request", async (t) => {
    const controller = new AbortController();
    const adapter = t.mock.method(LLM_ADAPTERS, "anthropic-messages", async () => reply);
    controller.abort();

    assert.deepEqual(await agentLoop({ messages: history(), loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }, controller.signal), { stop_reason: "cancelled" });
    assert.equal(adapter.mock.callCount(), 0);
});

test("cancellation stops an active request and the next run can complete", { timeout: 3000 }, async (t) => {
    const controller = new AbortController();
    const started = deferred();
    const messages = history();
    const events: TraceEvent[] = [];
    const adapter = t.mock.method(LLM_ADAPTERS, "anthropic-messages", (request: LlmRequest) => {
        assert.equal(request.signal, controller.signal);
        assert.ok(request.signal);
        started.resolve();
        return new Promise<AssistantMessage>((_, reject) => {
            request.signal!.addEventListener("abort", () => reject(new Error("Test request cancelled.")), { once: true });
        });
    });

    const state = { messages, loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    const pending = runAgentLoop(state, permissionCheck, controller.signal, event => events.push(event));
    await started.promise;
    controller.abort();
    assert.deepEqual(await pending, { stop_reason: "cancelled" });
    assert.equal(messages.length, 1);
    assert.deepEqual(events.map(event => event.type), ["run.started", "model.started", "model.finished", "run.finished"]);
    assert.deepEqual(events.flatMap(event => event.type === "model.finished" ? [event.status] : []), ["cancelled"]);
    assert.deepEqual(events.flatMap(event => event.type === "run.finished" ? [event.stop_reason] : []), ["cancelled"]);

    adapter.mock.mockImplementation(async () => reply);
    assert.deepEqual(await agentLoop({ messages, loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }, new AbortController().signal), {
        stop_reason: "completed",
        message: reply,
    });
    assert.deepEqual(messages, [...history(), reply]);
});

test("cancellation takes priority when a response arrives at the same time", async (t) => {
    const controller = new AbortController();
    const messages = history();
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async () => {
        controller.abort();
        return reply;
    });

    assert.deepEqual(await agentLoop({ messages, loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }, controller.signal), { stop_reason: "cancelled" });
    assert.equal(messages.length, 1);
});

test("cancellation skips pending tools and keeps their result messages", async (t) => {
    const controller = new AbortController();
    const messages = history();
    const adapter = t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (): Promise<AssistantMessage> => ({
        role: "assistant", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
        content: [
            { type: "toolCall", id: "first", name: "read_file", arguments: { filePath: "first" } },
            { type: "toolCall", id: "second", name: "read_file", arguments: { filePath: "second" } },
        ],
    }));
    const tool = t.mock.method(TOOL_HANDLERS, "read_file", async () => {
        controller.abort();
        return "The first tool completed.";
    });

    assert.deepEqual(await agentLoop({ messages, loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }, controller.signal), { stop_reason: "cancelled" });
    assert.equal(adapter.mock.callCount(), 1);
    assert.equal(tool.mock.callCount(), 1);
    assert.deepEqual(messages.slice(2), [
        { role: "tool", toolCallId: "first", toolName: "read_file", content: [{ type: "text", text: "The first tool completed." }] },
        { role: "tool", toolCallId: "second", toolName: "read_file", content: [{ type: "text", text: "Tool execution cancelled before it started." }] },
    ]);
});

test("cancellation reaches the active tool, skips later tools and hooks, and allows another run", { timeout: 3000 }, async (t) => {
    const controller = new AbortController();
    const started = deferred();
    const messages = history();
    const events: TraceEvent[] = [];
    const state = { messages, loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    const adapter = t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (): Promise<AssistantMessage> => ({
        role: "assistant", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
        content: [
            { type: "toolCall", id: "active-cancel", name: "read_file", arguments: { filePath: "active" } },
            { type: "toolCall", id: "pending-cancel", name: "read_file", arguments: { filePath: "pending" } },
        ],
    }));
    let postCalls = 0;
    onPostToolUse((call, output) => {
        if (call.id === "active-cancel" || call.id === "pending-cancel") postCalls++;
        return output;
    });
    const tool = t.mock.method(TOOL_HANDLERS, "read_file", async (_args: unknown, receivedState: State, signal?: AbortSignal) => {
        assert.equal(receivedState, state);
        assert.equal(signal, controller.signal);
        started.resolve();
        return new Promise<string>((_, reject) => {
            signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
    });

    const pending = runAgentLoop(state, permissionCheck, controller.signal, event => events.push(event));
    await started.promise;
    controller.abort("user-cancel");
    assert.deepEqual(await pending, { stop_reason: "cancelled" });
    assert.equal(tool.mock.callCount(), 1);
    assert.equal(adapter.mock.callCount(), 1);
    assert.equal(postCalls, 0);
    assert.deepEqual(events.flatMap(event => event.type === "tool.finished" ? [[event.tool_call_id, event.status]] : []), [
        ["active-cancel", "cancelled"], ["pending-cancel", "cancelled"],
    ]);
    assert.deepEqual(messages.slice(2), [
        { role: "tool", toolCallId: "active-cancel", toolName: "read_file", content: [{ type: "text", text: "Tool execution cancelled." }] },
        { role: "tool", toolCallId: "pending-cancel", toolName: "read_file", content: [{ type: "text", text: "Tool execution cancelled before it started." }] },
    ]);
    adapter.mock.mockImplementation(async () => reply);
    assert.deepEqual(await agentLoop(state, new AbortController().signal), { stop_reason: "completed", message: reply });
});

test("cancellation during a pre-tool hook prevents tool execution", async (t) => {
    const controller = new AbortController();
    const messages = history();
    onPreToolUse(call => {
        if (call.id === "cancel-in-hook") controller.abort();
        return call;
    });
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (): Promise<AssistantMessage> => ({
        role: "assistant", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
        content: [{ type: "toolCall", id: "cancel-in-hook", name: "read_file", arguments: { filePath: "unused" } }],
    }));
    const tool = t.mock.method(TOOL_HANDLERS, "read_file", async () => "Unexpected execution.");

    assert.deepEqual(await agentLoop({ messages, loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }, controller.signal), { stop_reason: "cancelled" });
    assert.equal(tool.mock.callCount(), 0);
    assert.equal(messages.at(-1)?.role, "tool");
});

test("ordinary tool errors remain tool results and a headless run has no stdout", async (t) => {
    const messages = history();
    const stdout = t.mock.method(process.stdout, "write");
    let requests = 0;
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (): Promise<AssistantMessage> => {
        if (requests++ > 0) return reply;
        return { role: "assistant", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 }, content: [{ type: "toolCall", id: "failure", name: "read_file", arguments: { filePath: "missing" } }] };
    });
    t.mock.method(TOOL_HANDLERS, "read_file", async () => { throw new Error("Read failed."); });

    assert.deepEqual(await agentLoop({ messages, loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } }), { stop_reason: "completed", message: reply });
    assert.equal(stdout.mock.callCount(), 0);
    assert.deepEqual(messages[2], { role: "tool", toolCallId: "failure", toolName: "read_file", content: [{ type: "text", text: "Error: Read failed." }] });
});

test("output and trace share the status of invalid, denied, and failed tool calls", async (t) => {
    const events: TraceEvent[] = [];
    const output: AgentOutputEvent[] = [];
    const state = { messages: history(), loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    const first = responseOutputToMessage([
        { type: "function_call", call_id: "invalid_json", name: "read_file", arguments: "{" },
        { type: "function_call", call_id: "invalid_schema", name: "read_file", arguments: "{}" },
        { type: "function_call", call_id: "denied", name: "read_file", arguments: '{"filePath":"unused"}' },
        { type: "function_call", call_id: "failure", name: "read_file", arguments: JSON.stringify({ filePath: `${import.meta.filename}/missing` }) },
    ]);
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (request: LlmRequest) => request.messages.length === 1 ? first : reply);

    const result = await runAgentLoop(state, async call => ({
        permission: call.id === "denied" ? "deny" : "allow", message: "private permission detail",
    }), undefined, event => events.push(event), event => output.push(event));

    assert.equal(result.stop_reason, "completed");
    assert.deepEqual(events.flatMap(event => event.type === "tool.finished" ? [[event.tool_call_id, event.status]] : []), [
        ["invalid_json", "invalid_arguments"], ["invalid_schema", "invalid_arguments"], ["denied", "denied"], ["failure", "error"],
    ]);
    assert.deepEqual(output, ["invalid_arguments", "invalid_arguments", "denied", "error"].map(status => ({
        type: "tool.finished", tool_name: "read_file", status,
    })));
    assert.doesNotMatch(JSON.stringify(events), /private permission detail|missing|ENOTDIR/);
});

test("an unexpected tool lifecycle error closes its trace and still rejects the run", async (t) => {
    const events: TraceEvent[] = [];
    const state = { messages: history(), loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    const error = new Error("Unexpected permission failure.");
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (): Promise<AssistantMessage> => ({
        ...reply, content: [{ type: "toolCall", id: "unexpected", name: "read_file", arguments: { filePath: "unused" } }],
    }));

    await assert.rejects(runAgentLoop(state, async () => { throw error; }, undefined, event => events.push(event)), error);

    assert.deepEqual(events.map(event => event.type), ["run.started", "model.started", "model.finished", "tool.started", "tool.finished", "run.finished"]);
    assert.deepEqual(events.flatMap(event => event.type === "tool.finished" ? [event.status] : []), ["error"]);
    assert.deepEqual(events.flatMap(event => event.type === "run.finished" ? [event.stop_reason] : []), ["error"]);
    assert.doesNotMatch(JSON.stringify(events), /Unexpected permission failure/);
});

function useTestKey(t: TestContext, api: LlmApi): void {
    const name = api === "openai-responses" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const previous = process.env[name];
    process.env[name] = "local-test-key";
    t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    });
}

for (const api of ["openai-responses", "anthropic-messages"] as const) {
    test(`${api} cancels the HTTP request before response headers`, { timeout: 3000 }, async (t) => {
        useTestKey(t, api);
        const controller = new AbortController();
        const started = deferred<AbortSignal>();
        const fetch = t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
            const signal = init?.signal;
            assert.ok(signal);
            started.resolve(signal);
            return new Promise<Response>((_, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        });

        const pending = LLM_ADAPTERS[api]({
            model: { api, model: "test-model" }, messages: history(), signal: controller.signal,
        });
        const rejected = assert.rejects(pending);
        const requestSignal = await started.promise;
        controller.abort();
        await rejected;
        assert.equal(requestSignal.aborted, true);
        assert.equal(fetch.mock.callCount(), 1);
    });

    test(`${api} cancels after the stream starts`, { timeout: 3000 }, async (t) => {
        useTestKey(t, api);
        const controller = new AbortController();
        const streamed = deferred();
        const partial = "partial-test-output";
        t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
            const signal = init?.signal;
            assert.ok(signal);
            const events = api === "openai-responses"
                ? [{ type: "response.output_text.delta", delta: partial }]
                : [
                    { type: "message_start", message: { id: "test", type: "message", role: "assistant", content: [], model: "test-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
                    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: partial } },
                ];
            const body = new ReadableStream<Uint8Array>({
                start(stream) {
                    for (const event of events) {
                        stream.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
                    }
                    signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
                },
            });
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
        });

        const pending = LLM_ADAPTERS[api]({
            model: { api, model: "test-model" }, messages: history(), signal: controller.signal,
            onText(event) {
                if (event.type === "text.delta" && event.text === partial) streamed.resolve();
            },
        });
        const rejected = assert.rejects(pending);
        await streamed.promise;
        controller.abort();
        await rejected;
    });

    test(`${api} sends text fragments once and keeps the complete model message`, async (t) => {
        useTestKey(t, api);
        const stdout = t.mock.method(process.stdout, "write");
        const output: ModelTextEvent[] = [];
        const parts = ["First part. ", "Second part."];
        const text = parts.join("");
        const thinking = "Private thinking.";
        const events = api === "openai-responses" ? [
            { type: "response.reasoning_text.delta", delta: thinking },
            ...parts.map(delta => ({ type: "response.output_text.delta", delta })),
            { type: "response.output_text.done", text },
            { type: "response.completed", response: { output: [
                { type: "reasoning", summary: [{ type: "summary_text", text: thinking }] },
                { type: "message", content: [{ type: "output_text", text }] },
            ] } },
        ] : [
            { type: "message_start", message: { id: "test", type: "message", role: "assistant", content: [], model: "test-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            ...parts.map(text => ({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })),
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
        ];
        const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
        t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
        const request: LlmRequest = { model: { api, model: "test-model" }, messages: history() };

        const message = await LLM_ADAPTERS[api]({ ...request, onText: event => output.push(event) });
        assert.deepEqual(await LLM_ADAPTERS[api](request), message);

        assert.equal(stdout.mock.callCount(), 0);
        assert.deepEqual(output, [{ type: "text.delta", text: parts[0] }, { type: "text.delta", text: parts[1] }, { type: "text.end" }]);
        assert.deepEqual(message.content[1], { type: "text", text });
        assert.equal(message.content[0]?.type === "thinking" && message.content[0].thinking, thinking);
    });
}
