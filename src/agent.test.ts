import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { agentLoop } from "./agent.ts";
import { LLM_ADAPTERS, responseOutputToMessage, messageToResponseInput, type AssistantMessage, type LlmApi, type LlmRequest, type Message } from "./llm.ts";
import { TOOL_HANDLERS } from "./tools.ts";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function history(): Message[] {
    return [{ role: "user", content: [{ type: "text", text: "Test the request." }] }];
}

const reply: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
};

test("a model error returns its cause without an assistant message", async (t) => {
    const messages = history();
    const error = new Error("Test request failed.");
    t.mock.method(LLM_ADAPTERS, "anthropic-messages", async () => { throw error; });

    assert.deepEqual(await agentLoop(messages), { stop_reason: "model_error", error });
    assert.equal(messages.length, 1);
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
    const bash = t.mock.method(TOOL_HANDLERS, "bash", async () => "The corrected tool completed.");

    assert.deepEqual(await agentLoop(messages), { stop_reason: "completed", message: reply });
    assert.equal(requests, 3);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(bash.mock.callCount(), 1);
    assert.deepEqual(bash.mock.calls[0]!.arguments, [{ commands: "pwd" }]);
});

test("a cancelled signal prevents a model request", async (t) => {
    const controller = new AbortController();
    const adapter = t.mock.method(LLM_ADAPTERS, "anthropic-messages", async () => reply);
    controller.abort();

    assert.deepEqual(await agentLoop(history(), controller.signal), { stop_reason: "cancelled" });
    assert.equal(adapter.mock.callCount(), 0);
});

test("cancellation stops an active request and the next run can complete", { timeout: 3000 }, async (t) => {
    const controller = new AbortController();
    const started = deferred();
    const messages = history();
    const adapter = t.mock.method(LLM_ADAPTERS, "anthropic-messages", (request: LlmRequest) => {
        assert.equal(request.signal, controller.signal);
        assert.ok(request.signal);
        started.resolve();
        return new Promise<AssistantMessage>((_, reject) => {
            request.signal!.addEventListener("abort", () => reject(new Error("Test request cancelled.")), { once: true });
        });
    });

    const pending = agentLoop(messages, controller.signal);
    await started.promise;
    controller.abort();
    assert.deepEqual(await pending, { stop_reason: "cancelled" });
    assert.equal(messages.length, 1);

    adapter.mock.mockImplementation(async () => reply);
    assert.deepEqual(await agentLoop(messages, new AbortController().signal), {
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

    assert.deepEqual(await agentLoop(messages, controller.signal), { stop_reason: "cancelled" });
    assert.equal(messages.length, 1);
});

test("cancellation skips pending tools and keeps their result messages", async (t) => {
    const controller = new AbortController();
    const messages = history();
    const adapter = t.mock.method(LLM_ADAPTERS, "anthropic-messages", async (): Promise<AssistantMessage> => ({
        role: "assistant",
        content: [
            { type: "toolCall", id: "first", name: "read_file", arguments: { filePath: "first" } },
            { type: "toolCall", id: "second", name: "read_file", arguments: { filePath: "second" } },
        ],
    }));
    const tool = t.mock.method(TOOL_HANDLERS, "read_file", async () => {
        controller.abort();
        return "The first tool completed.";
    });

    assert.deepEqual(await agentLoop(messages, controller.signal), { stop_reason: "cancelled" });
    assert.equal(adapter.mock.callCount(), 1);
    assert.equal(tool.mock.callCount(), 1);
    assert.deepEqual(messages.slice(2), [
        { role: "tool", toolCallId: "first", toolName: "read_file", content: [{ type: "text", text: "The first tool completed." }] },
        { role: "tool", toolCallId: "second", toolName: "read_file", content: [{ type: "text", text: "Tool execution cancelled before it started." }] },
    ]);
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
        const write = process.stdout.write.bind(process.stdout);
        t.mock.method(process.stdout, "write", (...args: Parameters<typeof process.stdout.write>) => {
            if (args[0] === partial) {
                streamed.resolve();
                return true;
            }
            return write(...args);
        });
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
        });
        const rejected = assert.rejects(pending);
        await streamed.promise;
        controller.abort();
        await rejected;
    });
}
