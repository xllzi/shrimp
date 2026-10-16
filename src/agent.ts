import { permissionCheck, type Finding } from "./permission.ts";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools.ts";
import { applyPreToolUse, applyPostToolUse, applyStop } from "./hooks.ts";
import { llmStream, type AssistantMessage, type Message, type ModelConfig, type ToolCall } from "./llm.ts";

const MODEL: ModelConfig = {
    api: "anthropic-messages",
    model: "deepseek-flash",
};

type State = {
    messages: Message[],
    turnCount: Number
}

type AgentLoopResult = 
    | { message: AssistantMessage, stop_reason: "completed"}
    | { error: unknown, stop_reason: "model_error"}
    | { stop_reason: "cancelled" }

/**
 * Run the model and its tool calls until a response has no tool calls.
 * Append each response and tool result to `messages` in place.
 * Return a separate result for a model error or a user cancellation.
 */
export async function agentLoop(messages: Message[], signal?: AbortSignal): Promise<AgentLoopResult> {
    while (true) {
        // After a cancellation, do not start another model request.
        if (signal?.aborted) return { stop_reason: "cancelled" };
        let response: AssistantMessage;
        try {
            response = await llmStream({
                model: MODEL,
                systemPrompt: "You are a thinking machine.",
                messages,
                tools: TOOL_DEFINITIONS,
                signal,
            });
        } catch (e) {
            return {error: e, stop_reason: "model_error"};
        }
        // A cancellation can occur as the model request ends.
        if (signal?.aborted) return { stop_reason: "cancelled" };
        // Keep the response before its tool results in the message history.
        messages.push(response);
        const toolCalls = response.content.filter((item): item is ToolCall => item.type === "toolCall");
        if (toolCalls.length > 0) {
            // Run the tool calls in the order of the response.
            for (let call of toolCalls) {
                let output = "";
                // Keep a result for each call, even if cancellation prevents its execution.
                if (signal?.aborted) {
                    output = "Tool execution cancelled before it started.";
                } else {
                    // The hook can change the tool call. Check permission for the changed call.
                    call = await applyPreToolUse(call);
                    let finding: Finding = await permissionCheck(call);
                    if (finding.permission === "allow") {
                        output = await runTool(call);
                    } else {
                        // Report the denial to the model. Do not run the tool.
                        output = finding.permission + ": " + finding.message;
                    }
                    output = await applyPostToolUse(call, output);
                }
                // Link the result to the tool call so the model can use it.
                messages.push({
                    role: "tool",
                    toolCallId: call.id,
                    toolName: call.name,
                    content: [{ type: "text", text: output }],
                });
                console.log("-----function call output-----");
                console.log(output);
            }
            // The next model request includes all tool results from this response.
        } else {
            // The loop stops normally only for a response without tool calls.
            await applyStop(response);
            return {message: response, stop_reason: "completed"};
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
