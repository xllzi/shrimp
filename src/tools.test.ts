import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { TOOL_HANDLERS } from "./tools.ts";
import type { State } from "./agent.ts";

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
        const state: State = { messages: [], turnCount: 0, readFileHashes: new Map<string, string>() };
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
        const state: State = { messages: [], turnCount: 0, readFileHashes: new Map<string, string>() };
        assert.equal(await TOOL_HANDLERS.read_file({ filePath }, state), scenario.content);

        const output = await TOOL_HANDLERS.edit_file({ filePath, oldText: scenario.oldText, newText: scenario.newText }, state);

        assert.equal(output, "replace file successfully");
        assert.equal(await readFile(filePath, "utf8"), scenario.expected);
    });
}

test("edit_file rejects an unread file without a file write", async (t) => {
    const filePath = await createFile(t, "alpha beta");
    const state: State = { messages: [], turnCount: 0, readFileHashes: new Map<string, string>() };
    const before = await stat(filePath);

    const output = await TOOL_HANDLERS.edit_file({ filePath, oldText: "beta", newText: "delta" }, state);

    assert.match(output, /never read/);
    assert.equal(await readFile(filePath, "utf8"), "alpha beta");
    assert.equal((await stat(filePath)).mtimeMs, before.mtimeMs);
});

test("edit_file rejects changed content until read_file refreshes the saved hash", async (t) => {
    const filePath = await createFile(t, "alpha beta");
    const state: State = { messages: [], turnCount: 0, readFileHashes: new Map<string, string>() };
    assert.equal(await TOOL_HANDLERS.read_file({ filePath }, state), "alpha beta");
    await writeFile(filePath, "alpha beta gamma");
    const before = await stat(filePath);
    const args = { filePath, oldText: "beta", newText: "delta" };

    assert.match(await TOOL_HANDLERS.edit_file(args, state), /file content changed/);
    assert.equal(await readFile(filePath, "utf8"), "alpha beta gamma");
    assert.equal((await stat(filePath)).mtimeMs, before.mtimeMs);

    assert.equal(await TOOL_HANDLERS.read_file({ filePath }, state), "alpha beta gamma");
    assert.equal(await TOOL_HANDLERS.edit_file(args, state), "replace file successfully");
    assert.equal(await readFile(filePath, "utf8"), "alpha delta gamma");
});
