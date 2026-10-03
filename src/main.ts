import readline from "node:readline/promises";
import { permissionCheck, type Finding } from "./permission.ts";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools.ts";
import { applyUserPromptSubmit, applyPreToolUse, applyPostToolUse, applyStop } from "./hooks.ts";
import { llmStream, type Message, type ModelConfig, type ToolCall } from "./llm.ts";

const MODEL: ModelConfig = {
    api: "openai-responses",
    model: "qwen3.8-27b",
};

/**
 * A ReAct Agent Loop
 */
async function agentLoop(messages: Message[]) {
    while (true) {
        const response = await llmStream({
            model: MODEL,
            systemPrompt: "You are a thinking machine.",
            messages,
            tools: TOOL_DEFINITIONS,
        });
        messages.push(response);
        const toolCalls = response.content.filter((item): item is ToolCall => item.type === "toolCall");
        if (toolCalls.length > 0) {
            // run each tool calls
            for (let call of toolCalls) {
                let output = ""; // tool output passed back to LLM
                // hooks may rewrite the call; permission then checks what will actually run
                call = await applyPreToolUse(call);
                let finding: Finding = await permissionCheck(call);
                if (finding.permission === "allow") { // REFACTOR: abstraction barrier break
                    output = await runTool(call);
                } else {
                    output = finding.permission + ": " + finding.message;
                }
                // construct function call output
                output = await applyPostToolUse(call, output);
                messages.push({
                    role: "tool",
                    toolCallId: call.id,
                    toolName: call.name,
                    content: [{ type: "text", text: output }],
                });
                console.log("-----function call output-----");
                console.log(output);
            }
        } else {
            await applyStop(response);
            return response;
        }
    }
}

async function runTool(call: ToolCall): Promise<string> {
    let output: string;
    // dispatch function and executed
    let fn = TOOL_HANDLERS[call.name];
    try {
        output = await fn(call.arguments);
    } catch (error) {
        output = String(error);
    }
    return output;
}

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
    while (1) {
        query = await ReadInterface.question("> ");
        if (query === ":q") break;
        query = await applyUserPromptSubmit({ query, history });
        history.push({ role: "user", content: [{ type: "text", text: query }] });
        const response = await agentLoop(history);
    }
    ReadInterface.close()
}

main();
