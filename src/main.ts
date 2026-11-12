import { parseBash } from "./adapter/bash.ts";
import { askPermission } from "./adapter/permission.ts";
import { createPermissionCheck } from "./app/permission.ts";
import { agentLoop } from "./app/agent.ts";
import { getReadInterface } from "./adapter/input.ts";
import { createJsonlTraceSink } from "./adapter/trace.ts";
import { countTokenUsage, summaryTurn } from "./app/usage.ts";
import type { Message, State } from "./domain/agent.ts";
import { applyUserPromptSubmit, onModelResponse, onStop } from "./app/hooks.ts";

export const ReadInterface = getReadInterface();
/**
 * main entry point
 */
async function main() {
    const permissionCheck = createPermissionCheck({ workspace: process.cwd(), parseBash, askPermission });
    const traceSink = process.env.SHRIMP_TRACE === "1" ? createJsonlTraceSink(".artifacts/traces") : undefined;
    let query = "";
    const history: Message[] = [];
    const state: State = {messages: history, loopCount: 0, readFileHashes: new Map<string, string>(), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 }}
    // Register hooks once before the input loop to prevent duplicate handlers.
    onModelResponse(countTokenUsage);
    onStop(summaryTurn);
    let activeController: AbortController | undefined;
    const cancel = () => {
        if (activeController) {
            activeController.abort();
        } else if (ReadInterface.terminal) {
            // At the input prompt, Ctrl+C clears the input.
            ReadInterface.write(null, { ctrl: true, name: "u" });
        }
    };
    // Keep both listeners for the full input session.
    // A late SIGINT must not stop the process after a cancellation.
    ReadInterface.on("SIGINT", cancel);
    process.on("SIGINT", cancel);
    try {
        while (1) {
            query = await ReadInterface.question("> ");
            if (query === ":q") break;
            query = await applyUserPromptSubmit({ query, history });
            history.push({ role: "user", content: [{ type: "text", text: query }] });
            // Each run needs a new controller. A cancelled signal cannot reset.
            const controller = new AbortController();
            activeController = controller;
            try {
                const response = await agentLoop(state, permissionCheck, controller.signal, traceSink);
                if (response.stop_reason === "model_error") {
                    console.error(response.error);
                } else if (response.stop_reason === "cancelled") {
                    console.log("\nCancelled.");
                }
            } finally {
                // The listeners must not use the controller from a completed run.
                activeController = undefined;
            }
        }
    } finally {
        // Remove both listeners when the input session ends.
        ReadInterface.off("SIGINT", cancel);
        process.off("SIGINT", cancel);
        ReadInterface.close();
    }
}

main();
