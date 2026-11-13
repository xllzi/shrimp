import readline from "node:readline/promises";
import { agentLoop, type AgentOutputEvent } from "../app/agent.ts";
import { applyUserPromptSubmit } from "../app/hooks.ts";
import { createPermissionCheck } from "../app/permission.ts";
import type { TraceSink } from "../app/trace.ts";
import type { State } from "../domain/agent.ts";
import { parseBash } from "./bash.ts";

export async function runCli(traceSink?: TraceSink): Promise<void> {
    const { stdin, stdout, stderr } = process;
    // Use one reader for the main prompt and the tool approval prompt.
    const reader = readline.createInterface({ input: stdin, output: stdout });
    const state: State = {
        messages: [],
        loopCount: 0,
        readFileHashes: new Map(),
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
    };

    let needsLineBreak = false;
    let showingThinking = false;
    // A stream can stop before it ends the current line.
    function finishText() {
        if (needsLineBreak) stdout.write("\n");
        needsLineBreak = false;
        showingThinking = false;
    }

    function render(event: AgentOutputEvent) {
        switch (event.type) {
            case "text.delta":
            case "thinking.delta":
                if (!event.text) break;
                if (event.type === "thinking.delta" && !showingThinking) {
                    finishText();
                    stdout.write("Thinking...\n");
                    showingThinking = true;
                } else if (event.type === "text.delta" && showingThinking) {
                    finishText();
                }
                stdout.write(event.text);
                needsLineBreak = !event.text.endsWith("\n");
                break;
            case "text.end":
            case "thinking.end":
                finishText();
                break;
            case "tool.finished":
                finishText();
                stdout.write(`${event.tool_name}: ${event.status}\n`);
                break;
        }
    }

    const permissionCheck = createPermissionCheck({
        workspace: process.cwd(),
        parseBash,
        async askPermission(call, signal) {
            signal?.throwIfAborted();
            finishText();
            stdout.write(`Tool call: ${call.name}\n${JSON.stringify(call.arguments)}\n`);
            while (true) {
                const answer = await reader.question("Approve this tool call? [y/n]", { signal });
                if (answer === "y") return "allow";
                if (answer === "n") return "deny";
                stdout.write("input y or n\n");
            }
        },
    });

    let activeController: AbortController | undefined;
    function cancel() {
        if (activeController) {
            activeController.abort();
        } else if (reader.terminal) {
            // Clear the input line when no run is active.
            reader.write(null, { ctrl: true, name: "u" });
        }
    }

    // Keep both listeners for the session so a late SIGINT does not end it.
    reader.on("SIGINT", cancel);
    process.on("SIGINT", cancel);
    try {
        while (true) {
            const input = await reader.question("> ");
            if (input === ":q") break;
            const query = await applyUserPromptSubmit({ query: input, history: state.messages });
            state.messages.push({ role: "user", content: [{ type: "text", text: query }] });

            // Use a new signal for each turn because an aborted signal cannot reset.
            const controller = new AbortController();
            activeController = controller;
            try {
                const result = await agentLoop(state, permissionCheck, controller.signal, traceSink, render);
                finishText();
                if (result.stop_reason === "model_error") {
                    stderr.write(`${String(result.error)}\n`);
                } else if (result.stop_reason === "cancelled") {
                    stdout.write("Cancelled.\n");
                }
            } finally {
                activeController = undefined;
            }
        }
    } finally {
        reader.off("SIGINT", cancel);
        process.off("SIGINT", cancel);
        reader.close();
    }
}
