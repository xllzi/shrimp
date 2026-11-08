import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall } from "./agent.ts";
import { bashVerdict, evaluatePermission } from "./permission.ts";

test("denial outranks approval requests and retains all Bash findings", () => {
    assert.deepEqual(bashVerdict({
        nodes: [
            { type: "command", name: "rm", words: ["-rf", "cache"] },
            { type: "command", name: "sudo", words: ["ls"] },
        ],
        hasError: true,
    }), {
        permission: "deny",
        message: "rm deletes recursively; `sudo` elevates privileges; bash did not parse cleanly, cannot fully verify",
    });
});

test("missing or malformed Bash syntax requires approval", () => {
    assert.equal(bashVerdict(null)?.permission, "ask");
    assert.equal(bashVerdict({ nodes: [], hasError: true })?.permission, "ask");
    const call: ToolCall = { type: "toolCall", id: "1", name: "bash", arguments: {} };
    assert.equal(evaluatePermission(call, { workspace: "/project" }).permission, "ask");
});

test("write rules use the supplied workspace and resolve relative paths", () => {
    for (const name of ["write_file", "edit_file"]) {
        for (const [filePath, permission] of [
            ["/project/src/a.ts", "allow"], ["src/a.ts", "allow"],
            ["../outside/a.ts", "ask"], ["/project-other/a.ts", "ask"],
            ["/project/../outside/a.ts", "ask"],
        ] as const) {
            const call: ToolCall = { type: "toolCall", id: "1", name, arguments: { filePath } };
            assert.equal(evaluatePermission(call, { workspace: "/project" }).permission, permission, `${name}: ${filePath}`);
        }
    }
});

test("write rules do not affect reads and a root workspace permits absolute paths", () => {
    const call: ToolCall = { type: "toolCall", id: "1", name: "read_file", arguments: { filePath: "/elsewhere/a" } };
    assert.equal(evaluatePermission(call, { workspace: "/project" }).permission, "allow");
    assert.equal(evaluatePermission({ ...call, name: "write_file" }, { workspace: "/" }).permission, "allow");
});
