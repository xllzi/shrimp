import type { ToolCall } from "../domain/agent.ts";
import { evaluatePermission, type Approval, type BashSyntax, type PermissionDecision } from "../domain/permission.ts";

export type PermissionCheck = (call: ToolCall, signal?: AbortSignal) => Promise<PermissionDecision>;

/**
 * Allow every tool call after checking for cancellation.
 * Use this check for isolated evaluation runs.
 */
export const allowAllPermissionCheck: PermissionCheck = async (_call, signal) => {
    signal?.throwIfAborted();
    return { permission: "allow", message: "" };
};

export interface PermissionDependencies {
    workspace: string;
    parseBash: (commands: string) => BashSyntax | null;
    askPermission: (call: ToolCall, signal?: AbortSignal) => Promise<Approval>;
}

/** Resolve an ask verdict through the supplied approval interface. */
export function createPermissionCheck({ workspace, parseBash, askPermission }: PermissionDependencies): PermissionCheck {
    return async (call, signal) => {
        signal?.throwIfAborted();
        const finding = evaluatePermission(call, {
            workspace,
            bash: call.name === "bash" ? parseBash(String(call.arguments.commands ?? "")) : undefined,
        });
        if (finding.permission !== "ask") {
            return { permission: finding.permission, message: finding.message };
        }
        signal?.throwIfAborted();
        const permission = await askPermission(call, signal);
        signal?.throwIfAborted();
        return { permission, message: finding.message + "\nuser " + permission };
    };
}
