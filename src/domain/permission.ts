import path from "node:path";
import type { ToolCall } from "./agent.ts";

/**
 * permission gate
 * allow: safe, runs without asking
 * ask:   risky or opaque, a human decides
 * deny:  dangerous, never runs
 */
export type Permission = "allow" | "ask" | "deny";

export const RANK: Record<Permission, number> = { allow: 0, ask: 1, deny: 2 };
export type Finding = { permission: Permission, message: string };
export type Verdict = Finding | null;

/** permission rule define how to check each type of tools permission */
export interface PermissionRule {
    tools: string[],
    check: (toolCall: ToolCall, context: PermissionContext) => Verdict,
}

export type Approval = Exclude<Permission, "ask">;
export type PermissionDecision = { permission: Approval; message: string };

/** Parser-independent facts, in syntax-tree traversal order. */
export type BashNode =
    | { type: "command"; name: string; words: string[] }
    | { type: "pipeline"; names: string[] }
    | { type: "redirect"; destination: string };

export interface BashSyntax {
    nodes: BashNode[];
    hasError: boolean;
}

export interface PermissionContext {
    workspace: string;
    bash?: BashSyntax | null;
}

/** Evaluate policy without prompting or reading process state. */
export function evaluatePermission(call: ToolCall, context: PermissionContext): Finding {
    let finding: Finding = { permission: "allow", message: "" };
    for (const rule of PERMISSION_RULES) {
        if (!rule.tools.includes(call.name)) continue;
        const verdict = rule.check(call, context);
        if (verdict && RANK[verdict.permission] > RANK[finding.permission]) {
            finding = verdict;
        }
    }
    return finding;
}

export const PERMISSION_RULES: PermissionRule[] = [
    {
        tools: ["bash"],
        check: (_call, context) => bashVerdict(context.bash ?? null),
    },
    {
        tools: ["write_file", "edit_file"],
        check: outOfWorkspace,
    }
];

function outOfWorkspace(toolCall: ToolCall, { workspace }: PermissionContext): Verdict {
    const filePath = path.resolve(workspace, String(toolCall.arguments.filePath ?? ""));
    const relative = path.relative(workspace, filePath);
    if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
        return null;
    }
    return { permission: "ask", message: "writes outside the workspace" };
}

/** class of string in bash command */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);
const POWER_OFF = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const DISK_DESTROYERS = new Set(["fdisk", "sfdisk", "cfdisk", "parted", "wipefs", "blockdev"]);
const REMOTE_FETCHERS = new Set(["curl", "wget"]);
const COMMAND_WRAPPERS = new Set(["env", "nohup", "nice", "stdbuf", "xargs", "command"]);
const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const SYSTEM_ROOTS = new Set(["/", "/*", "~", "~/*", "$HOME", "$HOME/*", "${HOME}", "${HOME}/*"]);

function isFlag(text: string): boolean {
    return /^-{1,2}[^-]/.test(text);
}

/** -rf contains both r and f; --recursive is separate */
function shortFlagSet(flags: string[], letter: string): boolean {
    return flags.some(f => !f.startsWith("--") && f.slice(1).includes(letter));
}

/** match one command against the rules */
function matchCommand(name: string, words: string[]): Verdict {
    const flags = words.filter(isFlag);
    const args = words.filter(w => !isFlag(w));

    if (name === "sudo" || name === "su" || name === "doas") {
        return { permission: "deny", message: `\`${name}\` elevates privileges` };
    }
    if (POWER_OFF.has(name) || (name === "systemctl" && args.some(a => POWER_OFF.has(a)))) {
        return { permission: "deny", message: `\`${name}\` powers off the host` };
    }
    if (name.startsWith("mkfs") || DISK_DESTROYERS.has(name)) {
        return { permission: "deny", message: `\`${name}\` destroys filesystem or partition data` };
    }
    if (name === "dd" && args.some(a => a.startsWith("of=/dev/") && !SAFE_DEVICES.has(a.slice(3)))) {
        return { permission: "deny", message: "dd writes directly to a device" };
    }
    if (name === "rm" && (shortFlagSet(flags, "r") || shortFlagSet(flags, "R") || flags.includes("--recursive"))) {
        const root = args.find(a => SYSTEM_ROOTS.has(a.replace(/\/+$/, "") || "/"));
        if (root !== undefined) {
            return { permission: "deny", message: `rm -r deletes \`${root}\`` };
        }
        return { permission: "ask", message: "rm deletes recursively" };
    }
    if (name === "eval" || (SHELL_INTERPRETERS.has(name) && shortFlagSet(flags, "c"))) {
        return { permission: "ask", message: `\`${name}\` runs a shell string the parser cannot inspect` };
    }
    return null;
}

/** check one `command` node, looking through wrapper commands like env/xargs */
function checkCommand({ name, words }: Extract<BashNode, { type: "command" }>): Verdict {
    const verdict = matchCommand(name, words);
    if (verdict || !COMMAND_WRAPPERS.has(name)) return verdict;
    const visible = words.filter(w => !/^[A-Za-z_][A-Za-z_0-9]*=/.test(w)); // drop FOO=1
    const innerName = visible.find(w => !isFlag(w));
    if (innerName === undefined) return null;
    return matchCommand(innerName, visible.slice(visible.indexOf(innerName) + 1));
}

/** a pipeline that fetches remote content and feeds a shell interpreter */
function checkPipeline(names: string[]): Verdict {
    if (names.some((n, i) => REMOTE_FETCHERS.has(n) && names.slice(i + 1).some(x => SHELL_INTERPRETERS.has(x)))) {
        return { permission: "ask", message: "pipeline executes remote content as shell code" };
    }
    return null;
}

/** a redirect aimed at a device file, e.g. `> /dev/sda` */
function checkRedirect(dest: string): Verdict {
    if (dest.startsWith("/dev/") && !SAFE_DEVICES.has(dest)) {
        return { permission: "deny", message: `redirect writes directly to \`${dest}\`` };
    }
    return null;
}

/** Apply Bash policy to parsed facts; parsing failure requires approval. */
export function bashVerdict(syntax: BashSyntax | null): Verdict {
    if (syntax === null) return { permission: "ask", message: "bash did not parse" };
    const findings: Finding[] = [];
    for (const node of syntax.nodes) {
        let verdict: Verdict;
        if (node.type === "command") verdict = checkCommand(node);
        else if (node.type === "pipeline") verdict = checkPipeline(node.names);
        else verdict = checkRedirect(node.destination);
        if (verdict !== null) findings.push(verdict);
    }
    if (syntax.hasError) {
        findings.push({ permission: "ask", message: "bash did not parse cleanly, cannot fully verify" });
    }
    if (findings.length === 0) return null;
    const worst = findings.reduce((a, b) => RANK[b.permission] > RANK[a.permission] ? b : a);
    return { permission: worst.permission, message: findings.map(f => f.message).join("; ") };
}

