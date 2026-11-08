import type { ToolCall } from "../domain/agent.ts";
import type { Approval } from "../domain/permission.ts";
import { getReadInterface } from "./input.ts";

/** Collect a terminal decision; permission rules are evaluated by the caller. */
export async function askPermission(toolCall: ToolCall, signal?: AbortSignal): Promise<Approval> {
    signal?.throwIfAborted();
    console.log("tool call: ", toolCall.name);
    console.log(JSON.stringify(toolCall.arguments));
    let permission!: Approval;
    const ReadInterface = getReadInterface();
    while (permission === undefined) {
        const answer = await ReadInterface.question("Approve this tool call? [y/n]", { signal });
        if (answer === 'y') permission = "allow";
        else if (answer === 'n') permission = "deny";
        else console.log("input y or n");
    }
    return permission;
}

