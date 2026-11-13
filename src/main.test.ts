import assert from "node:assert/strict";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, watch, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
    const textIndex = phase === "trace" ? 1 : 0;
    const commands = phase === "trace" ? "printf TRACE_%s TOOL_OUTPUT"
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
        ...(phase === "trace" ? [
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "TRACE_" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "THINKING_TEXT" } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "TRACE_THINKING_SIGNATURE" } },
            { type: "content_block_stop", index: 0 },
        ] : []),
        { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: "TEST_" } },
        { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: "COMPLETE" } },
        { type: "content_block_stop", index: textIndex },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
    ];
    const body = events.map(event => "event: " + event.type + "\\ndata: " + JSON.stringify(event) + "\\n\\n").join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
};
`;

async function startCli(
    t: TestContext,
    directory: string,
    command: string,
    args: string[],
    options: Pick<SpawnOptions, "env" | "detached">,
) {
    // Node uses Unix sockets for stdio: "pipe". FIFOs also work when socket I/O is restricted.
    const names = ["stdin", "stdout", "stderr"].map(name => path.join(directory, name));
    await promisify(execFile)("mkfifo", names);
    const childFds: number[] = [];
    const parentFds: number[] = [];
    try {
        for (const [index, name] of names.entries()) {
            // Open the read end first so the write end can open without waiting.
            const read = openSync(name, constants.O_RDONLY | constants.O_NONBLOCK);
            const readEnds = index === 0 ? childFds : parentFds;
            const writeEnds = index === 0 ? parentFds : childFds;
            readEnds.push(read);
            writeEnds.push(openSync(name, constants.O_WRONLY | constants.O_NONBLOCK));
        }
        const stdin = new Socket({ fd: parentFds.shift()!, readable: false, writable: true });
        const stdout = new Socket({ fd: parentFds.shift()!, readable: true, writable: false });
        const stderr = new Socket({ fd: parentFds.shift()!, readable: true, writable: false });
        const child = spawn(command, args, { ...options, cwd: directory, stdio: childFds });
        const closed = once(child, "close");
        t.after(async () => {
            try {
                if (child.pid && child.exitCode === null && child.signalCode === null) {
                    process.kill(options.detached ? -child.pid : child.pid, "SIGKILL");
                }
                await closed;
            } finally {
                stdin.destroy();
                stdout.destroy();
                stderr.destroy();
            }
        });
        return { child, stdin, stdout, stderr, closed };
    } finally {
        for (const fd of [...childFds, ...parentFds]) closeSync(fd);
    }
}

for (const launcher of ["node", "npm"] as const) {
  for (const phase of ["request", "tool", "permission"] as const) {
    test(`${launcher} keeps the input prompt after ${phase} cancellation and a late SIGINT`, {
        skip: process.platform === "win32",
        timeout: 5000,
    }, async (t) => {
        const directory = await mkdtemp(path.join(tmpdir(), "shrimp-cancel-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const preload = path.join(directory, "transport.mjs");
        const main = fileURLToPath(new URL("./main.ts", import.meta.url));
        await writeFile(preload, transport);
        await writeFile(path.join(directory, ".env"), "");
        await writeFile(path.join(directory, "package.json"), JSON.stringify({
            scripts: { dev: `node --env-file=.env '${main.replaceAll("'", "'\\''")}'` },
        }));
        const command = launcher === "node" ? process.execPath : "npm";
        const args = launcher === "node" ? [main] : ["run", "dev"];
        const { child, stdin, stdout, stderr, closed } = await startCli(t, directory, command, args, {
            detached: true,
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
        let output = "";
        let transcript = "";
        stdout.on("data", chunk => { output += chunk.toString(); transcript += chunk.toString(); });
        stderr.on("data", chunk => { output += chunk.toString(); transcript += chunk.toString(); });
        function expect(marker: string): Promise<void> {
            return new Promise((resolve, reject) => {
                const cleanup = () => {
                    stdout.off("data", check);
                    stderr.off("data", check);
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
                stdout.on("data", check);
                stderr.on("data", check);
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
        stdin.write("first\n");
        await firstActive;
        process.kill(-child.pid!, "SIGINT");
        await expect("Cancelled.");
        await expect("> ");

        process.kill(-child.pid!, "SIGINT");
        const secondActive = expectActive(2);
        stdin.write("second\n");
        await secondActive;
        process.kill(-child.pid!, "SIGINT");
        await expect("Cancelled.");
        await expect("> ");

        stdin.write("third\n");
        await expect("TEST_COMPLETE");
        await expect("> ");
        stdin.end(":q\n");
        assert.deepEqual(await closed, [0, null]);
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

        const main = fileURLToPath(new URL("./main.ts", import.meta.url));
        const { stdin, stdout, stderr: stderrStream, closed } = await startCli(t, directory, process.execPath, [main], {
            env: {
                ...process.env,
                ANTHROPIC_API_KEY: "local-test-key",
                SHRIMP_TRACE: mode === "disabled" ? undefined : "1",
                TEST_CANCEL_PHASE: "trace",
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            },
        });
        let stderr = "";
        stderrStream.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
        const stderrEnded = once(stderrStream, "end");
        const chunks = stdout.setEncoding("utf8")[Symbol.asyncIterator]();
        let output = "";
        let transcript = "";
        async function expect(marker: string) {
            let index = output.indexOf(marker);
            while (index === -1) {
                const chunk = await chunks.next();
                assert.equal(chunk.done, false, `CLI exited while waiting for ${marker}. ${stderr}`);
                output += chunk.value;
                transcript += chunk.value;
                index = output.indexOf(marker);
            }
            output = output.slice(index + marker.length);
        }

        await expect("> ");
        stdin.write("TRACE_PRIVATE_PROMPT\n");
        await expect("bash: completed\n");
        await expect("TEST_COMPLETE");
        await expect("> ");
        stdin.write("second prompt\n");
        await expect("TEST_COMPLETE");
        await expect("> ");
        stdin.end(":q\n");
        // The child close event does not wait for the parent to read the FIFOs.
        for (let chunk = await chunks.next(); !chunk.done; chunk = await chunks.next()) {
            transcript += chunk.value;
        }
        await stderrEnded;
        assert.deepEqual(await closed, [0, null]);
        const streamedResponse = "Thinking...\nTRACE_THINKING_TEXT\nTEST_COMPLETE\n";
        assert.equal(transcript, `> bash: completed\n${streamedResponse}> ${streamedResponse}> `);

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
            assert.doesNotMatch(raw, /TRACE_PRIVATE_PROMPT|TRACE_TOOL_OUTPUT|TRACE_THINKING_|TEST_COMPLETE/);
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
        assert.deepEqual(first.flatMap(event => event.type === "tool.started" ? [[event.round, event.tool_call_id, event.tool_name, event.arguments]] : []), [
            [1, "tool-1", "bash", { commands: "printf TRACE_%s TOOL_OUTPUT" }],
        ]);
        assert.deepEqual(first.flatMap(event => event.type === "tool.finished" ? [[event.round, event.tool_call_id, event.tool_name, event.status]] : []), [
            [1, "tool-1", "bash", "completed"],
        ]);
        assert.deepEqual(second.flatMap(event => event.type === "model.finished" ? [event.round] : []), [1]);
    });
}
