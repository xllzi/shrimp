import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, stat, utimes, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { State } from "./agent.ts";
import { TOOL_HANDLERS } from "../app/tools.ts";

async function createFile(t: TestContext, content: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "shrimp-edit-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "input.txt");
    await writeFile(filePath, content);
    await utimes(filePath, new Date(0), new Date(0));
    return filePath;
}

for (const scenario of [
    { name: "empty text", content: "alpha beta", oldText: "", error: /'oldText' must not be empty/ },
    { name: "no match", content: "alpha beta", oldText: "gamma", error: /does not contain `oldText`/ },
    { name: "several matches", content: "alpha beta alpha", oldText: "alpha", error: /contains `oldText` more than one time/ },
    { name: "overlapping matches", content: "aaa", oldText: "aa", error: /contains `oldText` more than one time/ },
]) {
    test(`edit_file rejects ${scenario.name} without a file write`, async (t) => {
        const filePath = await createFile(t, scenario.content);
        const state: State = { messages: [], loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
        assert.equal(await TOOL_HANDLERS.read_file({ filePath }, state), scenario.content);
        const before = await stat(filePath);

        const output = await TOOL_HANDLERS.edit_file({ filePath, oldText: scenario.oldText, newText: "replacement" }, state);

        assert.match(output, scenario.error);
        assert.equal(await readFile(filePath, "utf8"), scenario.content);
        assert.equal((await stat(filePath)).mtimeMs, before.mtimeMs);
    });
}

for (const scenario of [
    { name: "one match", content: "alpha beta gamma", oldText: "beta", newText: "delta", expected: "alpha delta gamma" },
    { name: "literal search text", content: "a-b a.b", oldText: "a.b", newText: "value", expected: "a-b value" },
    { name: "literal replacement text", content: "alpha beta gamma", oldText: "beta", newText: "$& $$ $` $'", expected: "alpha $& $$ $` $' gamma" },
    { name: "an empty replacement", content: "alpha beta gamma", oldText: "beta ", newText: "", expected: "alpha gamma" },
]) {
    test(`edit_file accepts ${scenario.name}`, async (t) => {
        const filePath = await createFile(t, scenario.content);
        const state: State = { messages: [], loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
        assert.equal(await TOOL_HANDLERS.read_file({ filePath }, state), scenario.content);

        const output = await TOOL_HANDLERS.edit_file({ filePath, oldText: scenario.oldText, newText: scenario.newText }, state);

        assert.equal(output, "replace text successfully");
        assert.equal(await readFile(filePath, "utf8"), scenario.expected);
    });
}

test("edit_file rejects an unread file without a file write", async (t) => {
    const filePath = await createFile(t, "alpha beta");
    const state: State = { messages: [], loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    const before = await stat(filePath);

    const output = await TOOL_HANDLERS.edit_file({ filePath, oldText: "beta", newText: "delta" }, state);

    assert.match(output, /File has not been read yet/);
    assert.equal(await readFile(filePath, "utf8"), "alpha beta");
    assert.equal((await stat(filePath)).mtimeMs, before.mtimeMs);
});

test("edit_file rejects changed content until read_file refreshes the saved hash", async (t) => {
    const filePath = await createFile(t, "alpha beta");
    const state: State = { messages: [], loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    assert.equal(await TOOL_HANDLERS.read_file({ filePath }, state), "alpha beta");
    await writeFile(filePath, "alpha beta gamma");
    const before = await stat(filePath);
    const args = { filePath, oldText: "beta", newText: "delta" };

    assert.match(await TOOL_HANDLERS.edit_file(args, state), /file content changed/);
    assert.equal(await readFile(filePath, "utf8"), "alpha beta gamma");
    assert.equal((await stat(filePath)).mtimeMs, before.mtimeMs);

    assert.equal(await TOOL_HANDLERS.read_file({ filePath }, state), "alpha beta gamma");
    assert.equal(await TOOL_HANDLERS.edit_file(args, state), "replace text successfully");
    assert.equal(await readFile(filePath, "utf8"), "alpha delta gamma");
});

test("bash cancellation stops the shell and its child commands", { skip: process.platform === "win32", timeout: 3000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "shrimp-bash-cancel-"));
    const controller = new AbortController();
    t.after(async () => {
        controller.abort();
        await rm(directory, { recursive: true, force: true });
    });
    const readyPath = path.join(directory, "ready");
    const leakedPath = path.join(directory, "leaked");
    const watcher = watch(directory);
    const ready = (async () => {
        for await (const event of watcher) {
            if (event.filename === "ready") return;
        }
    })();
    const state: State = { messages: [], loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    const pending = TOOL_HANDLERS.bash({
        commands: `trap '' TERM; (sleep 0.2; printf leaked > '${leakedPath}') & printf ready > '${readyPath}'; wait`,
    }, state, controller.signal);
    const rejected = assert.rejects(Promise.resolve(pending), error => error === controller.signal.reason);
    await ready;
    controller.abort();
    await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await setTimeout(300);
    await assert.rejects(stat(leakedPath), { code: "ENOENT" });
    assert.equal(await TOOL_HANDLERS.bash({ commands: "printf recovered" }, state), "recovered");
});

test("bash preserves stdout and reports command failures", async () => {
    const state: State = { messages: [], loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
    assert.equal(await TOOL_HANDLERS.bash({ commands: "printf hello" }, state), "hello");
    await assert.rejects(Promise.resolve(TOOL_HANDLERS.bash({ commands: "printf failure >&2; exit 7" }, state)), /failed \(7\): failure/);
});

for (const name of ["bash", "read_file", "write_file", "edit_file"] as const) {
    test(`${name} rejects an already cancelled signal without changing the file`, async (t) => {
        const filePath = await createFile(t, "original");
        const controller = new AbortController();
        controller.abort("user-cancel");
        const state: State = { messages: [], loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
        await assert.rejects(Promise.resolve(TOOL_HANDLERS[name]({
            filePath, commands: `printf changed > '${filePath}'`, content: "changed", oldText: "original", newText: "changed",
        }, state, controller.signal)), error => error === "user-cancel");
        assert.equal(await readFile(filePath, "utf8"), "original");
        assert.equal(state.readFileHashes.size, 0);
    });
}

for (const name of ["read_file", "write_file", "edit_file"] as const) {
    test(`${name} cancels an active file operation`, async (t) => {
        const filePath = await createFile(t, "original");
        const state: State = { messages: [], loopCount: 0, readFileHashes: new Map(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } };
        await TOOL_HANDLERS.read_file({ filePath }, state);
        const previousHash = state.readFileHashes.get(filePath);
        const controller = new AbortController();
        const pending = TOOL_HANDLERS[name]({ filePath, content: "changed", oldText: "original", newText: "changed" }, state, controller.signal);
        const rejected = assert.rejects(Promise.resolve(pending), error => error === controller.signal.reason);
        controller.abort();
        await rejected;
        assert.equal(state.readFileHashes.get(filePath), previousHash);
        if (name === "edit_file") assert.equal(await readFile(filePath, "utf8"), "original");
    });
}
