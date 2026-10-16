import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { TOOL_HANDLERS } from "./tools.ts";

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
        const before = await stat(filePath);

        const output = await TOOL_HANDLERS.edit_file({ filePath, oldText: scenario.oldText, newText: "replacement" });

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

        const output = await TOOL_HANDLERS.edit_file({ filePath, oldText: scenario.oldText, newText: scenario.newText });

        assert.equal(output, "replace file successfully");
        assert.equal(await readFile(filePath, "utf8"), scenario.expected);
    });
}
