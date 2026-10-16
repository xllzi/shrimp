import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const transport = `
let requests = 0;
globalThis.fetch = async (_input, init) => {
    requests++;
    if (requests <= 2) {
        process.stdout.write("TEST_WAIT_" + requests + "\\n");
        return new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
    }
    const events = [
        { type: "message_start", message: { id: "test", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "TEST_COMPLETE" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
    ];
    const body = events.map(event => "event: " + event.type + "\\ndata: " + JSON.stringify(event) + "\\n\\n").join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
};
`;

for (const launcher of ["node", "npm"] as const) {
    test(`${launcher} keeps the input prompt after cancellation and a late SIGINT`, {
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

        await expect("> ");
        child.stdin.write("first\n");
        await expect("TEST_WAIT_1");
        process.kill(-child.pid!, "SIGINT");
        await expect("Cancelled.");
        await expect("> ");

        process.kill(-child.pid!, "SIGINT");
        child.stdin.write("second\n");
        await expect("TEST_WAIT_2");
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
