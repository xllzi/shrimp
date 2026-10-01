import type { ToolCall } from "./llm.ts";
import { Parser, Language, type Node as SyntaxNode } from "web-tree-sitter";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
/**
 * permission gate
 * allow: safe, runs without asking
 * ask:   risky or opaque, a human decides
 * deny:  dangerous, never runs
 */
export type Permission = "allow" | "ask" | "deny";

export const RANK: Record<Permission, number> = { allow: 0, ask: 1, deny: 2 };
export type Finding = { permission: Permission, message: string };
type Verdict = Finding | null;

// parse bash into a syntax tree; both wasm files ship inside the packages
const require = createRequire(import.meta.url);
await Parser.init();
const bash = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
const bashParser = new Parser();
bashParser.setLanguage(bash);

/** class of string in bash command */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);
const POWER_OFF = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const DISK_DESTROYERS = new Set(["fdisk", "sfdisk", "cfdisk", "parted", "wipefs", "blockdev"]);
const REMOTE_FETCHERS = new Set(["curl", "wget"]);
const COMMAND_WRAPPERS = new Set(["env", "nohup", "nice", "stdbuf", "xargs", "command"]);
const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const SYSTEM_ROOTS = new Set(["/", "/*", "~", "~/*", "$HOME", "$HOME/*", "${HOME}", "${HOME}/*"]);

/**
 * permisstionCheck check a function tool call for permission: allow, ask, deny
 * ask permission will trigger askPermission directly
 * eventually output only two kind of permission: allow or deny and message
 */
export async function permissionCheck(call: ToolCall): Promise<Finding> {
    let permission: Permission = "allow"
    let message = "";
    for (let rule of PERMISSION_RULES) {
        if (!rule.tools.includes(call.name)) continue;
        const verdict = rule.check(call);
        if (verdict && RANK[verdict.permission] > RANK[permission]) {
            permission = verdict.permission;
            message = verdict.message;
        }
    }
    if (permission === "ask") {
        permission = await askPermission(call);
        message += "\nuser " + permission;
    }
    return {permission, message};
}

export async function askPermission(toolCall: ToolCall): Promise<Permission> {
    console.log("tool call: ", toolCall.name);
    console.log(JSON.stringify(toolCall.arguments));
    let permission!: Permission;
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })
    while (permission === undefined) {
        const answer = await rl.question("Approve this tool call? [y/n]");
        if (answer === 'y') permission = "allow";
        else if (answer === 'n') permission = "deny";
        else console.log("input y or n");
    }
    rl.close();
    return permission;
}

function unquote(text: string): string {
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
        return text.slice(1, -1);
    }
    return text;
}

function isFlag(text: string): boolean {
    return /^-{1,2}[^-]/.test(text);
}

/** -rf contains both r and f; --recursive is separate */
function shortFlagSet(flags: string[], letter: string): boolean {
    return flags.some(f => !f.startsWith("--") && f.slice(1).includes(letter));
}

function commandName(cmd: SyntaxNode): string {
    return cmd.namedChildren.find(c => c.type === "command_name")?.text ?? "";
}

/** split a `command` node into its name and word arguments (quotes stripped) */
function splitCommand(cmd: SyntaxNode): { name: string, words: string[] } {
    const words: string[] = [];
    for (const child of cmd.namedChildren) {
        if (child.type === "command_name" || child.type === "variable_assignment") continue;
        words.push(unquote(child.text));
    }
    return { name: commandName(cmd), words };
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
function checkCommand(cmd: SyntaxNode): Verdict {
    const { name, words } = splitCommand(cmd);
    const verdict = matchCommand(name, words);
    if (verdict || !COMMAND_WRAPPERS.has(name)) return verdict;
    const visible = words.filter(w => !/^[A-Za-z_][A-Za-z_0-9]*=/.test(w)); // drop FOO=1
    const innerName = visible.find(w => !isFlag(w));
    if (innerName === undefined) return null;
    return matchCommand(innerName, visible.slice(visible.indexOf(innerName) + 1));
}

/** a pipeline that fetches remote content and feeds a shell interpreter */
function checkPipeline(pipe: SyntaxNode): Verdict {
    const names = pipe.namedChildren
        .filter(c => c.type === "command")
        .map(commandName);
    if (names.some((n, i) => REMOTE_FETCHERS.has(n) && names.slice(i + 1).some(x => SHELL_INTERPRETERS.has(x)))) {
        return { permission: "ask", message: "pipeline executes remote content as shell code" };
    }
    return null;
}

/** a redirect aimed at a device file, e.g. `> /dev/sda` */
function checkRedirect(redir: SyntaxNode): Verdict {
    const target = redir.namedChildren[0];
    if (target === undefined) return null;
    const dest = unquote(target.text);
    if (dest.startsWith("/dev/") && !SAFE_DEVICES.has(dest)) {
        return { permission: "deny", message: `redirect writes directly to \`${dest}\`` };
    }
    return null;
}

/**
 * walk the whole syntax tree — lists, pipelines, loops, subshells and command
 * substitutions included — so nothing hides from the rules above
 */
export function bashVerdict(commands: string): Verdict {
    const tree = bashParser.parse(commands);
    if (tree === null) return { permission: "ask", message: "bash did not parse" };
    const findings: Finding[] = [];
    const walk = (node: SyntaxNode): void => {
        let verdict: Verdict = null;
        if (node.type === "command") verdict = checkCommand(node);
        else if (node.type === "pipeline") verdict = checkPipeline(node);
        else if (node.type === "file_redirect") verdict = checkRedirect(node);
        if (verdict !== null) findings.push(verdict);
        for (const child of node.namedChildren) walk(child);
    };
    walk(tree.rootNode);
    if (tree.rootNode.hasError) {
        findings.push({ permission: "ask", message: "bash did not parse cleanly, cannot fully verify" });
    }
    if (findings.length === 0) return null;
    const worst = findings.reduce((a, b) => RANK[b.permission] > RANK[a.permission] ? b : a);
    return { permission: worst.permission, message: findings.map(f => f.message).join("; ") };
}

interface PermissionRule {
    tools: string[],
    check: (toolCall: ToolCall) => Verdict,
}

export const PERMISSION_RULES: PermissionRule[] = [
    {
        tools: ["bash"],
        check: (call) => bashVerdict(String(call.arguments.commands ?? "")),
    },
    {
        tools: ["write_file", "edit_file"],
        check: outOfWorkspace,
    }
];

function outOfWorkspace(toolCall: ToolCall): Verdict {
    let dir = path.dirname(String(toolCall.arguments.filePath ?? ""));
    if (process.cwd() === "/") return null;
    while (dir !== "/") {
        if (dir === process.cwd()) {
            return null;
        }
        dir = path.dirname(dir);
    }
    return { permission: "ask", message: "writes outside the workspace" };
}
