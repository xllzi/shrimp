import readline from "node:readline/promises";
import { applyUserPromptSubmit } from "./hooks.ts";
import type { Message } from "./llm.ts";
import { agentLoop } from "./agent.ts"

export const ReadInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})
/**
 * main entry point
 */
async function main() {
    let query = "";
    const history: Message[] = [];
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
                const response = await agentLoop(history, controller.signal);
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
