import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall } from "../domain/agent.ts";
import { allowAllPermissionCheck, createPermissionCheck } from "./permission.ts";

const call: ToolCall = { type: "toolCall", id: "1", name: "bash", arguments: { commands: "a command" } };

test("allow-all accepts calls that interactive mode blocks or sends for approval", async () => {
    const outsideWrite: ToolCall = { ...call, name: "write_file", arguments: { filePath: "../outside.txt", content: "example" } };
    let prompts = 0;
    const interactiveCheck = createPermissionCheck({
        workspace: "/project",
        parseBash: () => ({ nodes: [{ type: "command", name: "sudo", words: [] }], hasError: false }),
        askPermission: async () => { prompts++; return "deny"; },
    });

    assert.equal((await interactiveCheck(call)).permission, "deny");
    assert.equal((await interactiveCheck(outsideWrite)).permission, "deny");
    assert.equal(prompts, 1);
    assert.equal((await allowAllPermissionCheck(call)).permission, "allow");
    assert.equal((await allowAllPermissionCheck(outsideWrite, new AbortController().signal)).permission, "allow");
    assert.equal(prompts, 1);
});

test("allow-all rejects an already cancelled call with the abort reason", async () => {
    const reason = new Error("Cancelled before check");

    await assert.rejects(allowAllPermissionCheck(call, AbortSignal.abort(reason)), error => error === reason);
});

test("allow and deny verdicts never request approval", async () => {
    for (const [name, expected] of [["pwd", "allow"], ["sudo", "deny"]] as const) {
        const check = createPermissionCheck({
            workspace: "/project",
            parseBash: commands => {
                assert.equal(commands, call.arguments.commands);
                return { nodes: [{ type: "command", name, words: [] }], hasError: false };
            },
            askPermission: async () => { throw new Error("Unexpected approval"); },
        });
        assert.equal((await check(call)).permission, expected);
    }
});

for (const approval of ["allow", "deny"] as const) {
    test(`an ask verdict resolves to the user's ${approval} decision`, async () => {
        const controller = new AbortController();
        let prompts = 0;
        const check = createPermissionCheck({
            workspace: "/project",
            parseBash: () => null,
            askPermission: async (received, signal) => {
                prompts++;
                assert.equal(received, call);
                assert.equal(signal, controller.signal);
                return approval;
            },
        });
        assert.deepEqual(await check(call, controller.signal), {
            permission: approval, message: `bash did not parse\nuser ${approval}`,
        });
        assert.equal(prompts, 1);
    });
}

test("file approval does not invoke the Bash parser", async () => {
    const check = createPermissionCheck({
        workspace: "/project",
        parseBash: () => { throw new Error("Unexpected parsing"); },
        askPermission: async () => "deny",
    });
    assert.deepEqual(await check({ ...call, name: "write_file", arguments: { filePath: "/outside/a" } }), {
        permission: "deny", message: "writes outside the workspace\nuser deny",
    });
});

test("an already cancelled check neither parses nor prompts", async () => {
    const controller = new AbortController();
    const reason = new Error("Cancelled before check");
    controller.abort(reason);
    const check = createPermissionCheck({
        workspace: "/project",
        parseBash: () => { throw new Error("Unexpected parsing"); },
        askPermission: async () => { throw new Error("Unexpected approval"); },
    });
    await assert.rejects(check(call, controller.signal), error => error === reason);
});

test("cancellation while approval is pending prevents an allow result", async () => {
    const controller = new AbortController();
    const reason = new Error("Cancelled during approval");
    const check = createPermissionCheck({
        workspace: "/project", parseBash: () => null,
        askPermission: async () => { controller.abort(reason); return "allow"; },
    });
    await assert.rejects(check(call, controller.signal), error => error === reason);
});

test("approval failures propagate instead of granting permission", async () => {
    const reason = new Error("Approval interface unavailable");
    const check = createPermissionCheck({
        workspace: "/project", parseBash: () => null,
        askPermission: async () => { throw reason; },
    });
    await assert.rejects(check(call), error => error === reason);
});
