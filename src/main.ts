import { getReadInterface } from "./input.ts";
import { applyUserPromptSubmit, onModelResponse, onStop } from "./hooks.ts";
import type { Message } from "./llm.ts";
import { agentLoop, summaryTurn, type State } from "./agent.ts"
import { countTokenUsage } from "./usage.ts";

export const ReadInterface = getReadInterface();
/**
 * main entry point
 */
async function main() {
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
                const response = await agentLoop(state, controller.signal);
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
