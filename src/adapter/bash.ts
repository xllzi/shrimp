import { createRequire } from "node:module";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import type { BashNode, BashSyntax } from "../domain/permission.ts";

// parse bash into a syntax tree; both wasm files ship inside the packages
const require = createRequire(import.meta.url);
await Parser.init();
const bash = await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
const bashParser = new Parser();
bashParser.setLanguage(bash);

function unquote(text: string): string {
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
        return text.slice(1, -1);
    }
    return text;
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

/** Extract facts without deciding whether a command is permitted. */
export function parseBash(commands: string): BashSyntax | null {
    const tree = bashParser.parse(commands);
    if (tree === null) return null;
    try {
        const nodes: BashNode[] = [];
        const walk = (node: SyntaxNode): void => {
            if (node.type === "command") {
                nodes.push({ type: "command", ...splitCommand(node) });
            } else if (node.type === "pipeline") {
                nodes.push({
                    type: "pipeline",
                    names: node.namedChildren.filter(child => child.type === "command").map(commandName),
                });
            } else if (node.type === "file_redirect") {
                const target = node.namedChildren[0];
                if (target) nodes.push({ type: "redirect", destination: unquote(target.text) });
            }
            for (const child of node.namedChildren) walk(child);
        };
        walk(tree.rootNode);
        return { nodes, hasError: tree.rootNode.hasError };
    } finally {
        tree.delete();
    }
}
