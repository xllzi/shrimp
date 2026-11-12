import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TraceEvent } from "./app/trace.ts";

const transport = `
let requests = 0;
globalThis.fetch = async (_input, init) => {
    requests++;
    const phase = process.env.TEST_CANCEL_PHASE;
    if (phase === "trace" && requests === 2) {
        const [result] = JSON.parse(init.body).messages.at(-1).content;
        if (result.type !== "tool_result" || result.content[0]?.text !== "TRACE_TOOL_OUTPUT") {
            throw new Error("The model did not receive the full tool output.");
        }
    }
    if (requests <= 2 && phase === "request") {
        process.stdout.write("TEST_WAIT_" + requests + "\\n");
        return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
    }
    const tool = requests <= (phase === "trace" ? 1 : 2);
    const commands = phase === "trace" ? "printf TRACE_TOOL_OUTPUT"
        : phase === "permission" ? "bash -c 'sleep 60'"
        : "sleep 60 & printf ready > '" + process.env.TEST_TOOL_DIRECTORY + "/ready-" + requests + "'; wait";
    const events = tool ? [
        { type: "message_start", message: { id: "test", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-" + requests, name: "bash", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ commands }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
    ] : [
        { type: "message_start", message: { id: "test", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "TEST_" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "COMPLETE" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
    ];
    const body = events.map(event => "event: " + event.type + "\\ndata: " + JSON.stringify(event) + "\\n\\n").join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
};
`;

for (const launcher of ["node", "npm"] as const) {
  for (const phase of ["request", "tool", "permission"] as const) {
    test(`${launcher} keeps the input prompt after ${phase} cancellation and a late SIGINT`, {
        skip: process.platform === "win32",
        timeout: 5000,
    }, async (t) => {
        const directory = await mkdtemp(path.join(tmpdir(), "shrimp-cancel-"));
        const preload = path.join(directory, "transport.mjs");
        const main = fileURLToPath(new URL("./main.ts", import.meta.url));
        await writeFile(preload, transport);
        await writeFile(path.join(directory, ".env"), "");
        await writeFile(path.join(directory, "package.json"), JSON.stringify({
            scripts: { dev: `node --env-file=.env '${main.replaceAll("'", "'\\''")}'` },
        }));
        const child = spawn(launcher === "node" ? process.execPath : "npm", launcher === "node" ? [main] : ["run", "dev"], {
            cwd: directory,
            detached: true,
            stdio: "pipe",
            env: {
                ...process.env,
                ANTHROPIC_API_KEY: "local-test-key",
                SHRIMP_TRACE: "0",
                TEST_CANCEL_PHASE: phase,
                TEST_TOOL_DIRECTORY: directory,
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
                npm_config_cache: path.join(directory, "npm-cache"),
            },
        });
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) {
                const exit = once(child, "exit");
                process.kill(-child.pid!, "SIGKILL");
                await exit;
            }
            await rm(directory, { recursive: true, force: true });
        });
        let output = "";
        let transcript = "";
        child.stdout.on("data", chunk => { output += chunk.toString(); transcript += chunk.toString(); });
        child.stderr.on("data", chunk => { output += chunk.toString(); transcript += chunk.toString(); });
        function expect(marker: string): Promise<void> {
            return new Promise((resolve, reject) => {
                const cleanup = () => {
                    child.stdout.off("data", check);
                    child.stderr.off("data", check);
                    child.off("exit", onExit);
                };
                const onExit = () => {
                    cleanup();
                    reject(new Error(`Process exited (${child.exitCode}, ${child.signalCode}) before ${marker}: ${transcript}`));
                };
                const check = () => {
                    const index = output.indexOf(marker);
                    if (index === -1) return;
                    output = output.slice(index + marker.length);
                    cleanup();
                    resolve();
                };
                child.stdout.on("data", check);
                child.stderr.on("data", check);
                child.once("exit", onExit);
                check();
                if (child.exitCode !== null || child.signalCode !== null) onExit();
            });
        }

        async function expectActive(index: number) {
            if (phase !== "tool") {
                await expect(phase === "request" ? `TEST_WAIT_${index}` : "Approve this tool call? [y/n]");
                return;
            }
            for await (const event of watch(directory, { signal: t.signal })) {
                if (event.filename === `ready-${index}`) return;
            }
        }

        await expect("> ");
        const firstActive = expectActive(1);
        child.stdin.write("first\n");
        await firstActive;
        process.kill(-child.pid!, "SIGINT");
        await expect("Cancelled.");
        await expect("> ");

        process.kill(-child.pid!, "SIGINT");
        const secondActive = expectActive(2);
        child.stdin.write("second\n");
        await secondActive;
        process.kill(-child.pid!, "SIGINT");
        await expect("Cancelled.");
        await expect("> ");

        child.stdin.write("third\n");
        await expect("TEST_COMPLETE");
        await expect("> ");
        const exit = once(child, "exit");
        child.stdin.write(":q\n");
        assert.deepEqual(await exit, [0, null]);
    });
  }
}

for (const mode of ["enabled", "disabled", "blocked"] as const) {
    test(`CLI tracing with output ${mode}`, { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
        const directory = await mkdtemp(path.join(tmpdir(), "shrimp-trace-"));
        const preload = path.join(directory, "transport.mjs");
        const artifacts = path.join(directory, ".artifacts");
        const traces = path.join(artifacts, "traces");
        t.after(() => rm(directory, { recursive: true, force: true }));
        await writeFile(preload, transport);
        if (mode === "blocked") await writeFile(artifacts, "A file blocks directory creation.");

        const child = spawn(process.execPath, [fileURLToPath(new URL("./main.ts", import.meta.url))], {
            cwd: directory,
            stdio: "pipe",
            env: {
                ...process.env,
                ANTHROPIC_API_KEY: "local-test-key",
                SHRIMP_TRACE: mode === "disabled" ? undefined : "1",
                TEST_CANCEL_PHASE: "trace",
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            },
        });
        const closed = once(child, "close");
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await closed;
        });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
        const stdout = child.stdout.setEncoding("utf8")[Symbol.asyncIterator]();
        let output = "";
        let transcript = "";
        async function expect(marker: string) {
            let index = output.indexOf(marker);
            while (index === -1) {
                const chunk = await stdout.next();
                assert.equal(chunk.done, false, `CLI exited while waiting for ${marker}. ${stderr}`);
                output += chunk.value;
                transcript += chunk.value;
                index = output.indexOf(marker);
            }
            output = output.slice(index + marker.length);
        }

        await expect("> ");
        child.stdin.write("TRACE_PRIVATE_PROMPT\n");
        await expect("bash: completed\n");
        await expect("TEST_COMPLETE");
        await expect("> ");
        child.stdin.write("second prompt\n");
        await expect("TEST_COMPLETE");
        await expect("> ");
        child.stdin.end(":q\n");
        assert.deepEqual(await closed, [0, null]);
        assert.equal(transcript, "> bash: completed\nTEST_COMPLETE\n> TEST_COMPLETE\n> ");

        const warnings = stderr.match(/Shrimp could not write trace events/g) ?? [];
        assert.equal(warnings.length, mode === "blocked" ? 1 : 0);
        if (mode !== "enabled") {
            await assert.rejects(readdir(traces), { code: mode === "disabled" ? "ENOENT" : "ENOTDIR" });
            return;
        }

        const files = await readdir(traces);
        assert.equal(files.length, 2);
        const attempts = await Promise.all(files.map(async filename => {
            const raw = await readFile(path.join(traces, filename), "utf8");
            assert.doesNotMatch(raw, /TRACE_PRIVATE_PROMPT|TRACE_TOOL_OUTPUT|TEST_COMPLETE/);
            const events: TraceEvent[] = raw.trimEnd().split("\n").map(line => JSON.parse(line));
            for (const [index, event] of events.entries()) {
                assert.equal(`${event.attempt_id}.jsonl`, filename);
                assert.equal(event.sequence, index + 1);
                assert.ok(Number.isFinite(Date.parse(event.timestamp)));
                if ("duration_ms" in event) assert.ok(Number.isFinite(event.duration_ms) && event.duration_ms >= 0);
            }
            assert.equal(events[0]?.type, "run.started");
            assert.deepEqual(events.flatMap(event => event.type === "run.finished" ? [event.stop_reason] : []), ["completed"]);
            assert.equal(events.at(-1)?.type, "run.finished");
            return events;
        }));
        const [second, first] = attempts.sort((a, b) => a.length - b.length);
        assert.deepEqual(second.map(event => event.type), ["run.started", "model.started", "model.finished", "run.finished"]);
        assert.deepEqual(first.map(event => event.type), ["run.started", "model.started", "model.finished", "tool.started", "tool.finished", "model.started", "model.finished", "run.finished"]);
        assert.deepEqual(first.flatMap(event => event.type === "model.finished" ? [[event.round, event.status, event.usage]] : []), [
            [1, "completed", { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }],
            [2, "completed", { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }],
        ]);
        assert.deepEqual(first.flatMap(event => event.type === "tool.finished" ? [[event.round, event.tool_call_id, event.tool_name, event.status]] : []), [
            [1, "tool-1", "bash", "completed"],
        ]);
        assert.deepEqual(second.flatMap(event => event.type === "model.finished" ? [event.round] : []), [1]);
    });
}
