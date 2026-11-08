import { type ModelConfig, llmStream } from "../adapter/llm.ts";
import type { AssistantMessage, InvalidToolCall, State, ToolCall } from "../domain/agent.ts";
import { applyModelResponse, applyPostToolUse, applyPreToolUse, applyStop } from "./hooks.ts";
import type { Finding } from "../domain/permission.ts";
import { TOOL_DEFINITIONS } from "../domain/tools.ts";
import type { PermissionCheck } from "./permission.ts";
import { runTool } from "./tools.ts";

const MODEL: ModelConfig = {
    api: "anthropic-messages",
    model: "deepseek-flash",
};

type AgentLoopResult = 
    | { message: AssistantMessage, stop_reason: "completed"}
    | { error: unknown, stop_reason: "model_error"}
    | { stop_reason: "cancelled" }

/**
 * Run the model and its tool calls until a response has no tool calls.
 * Append each response and tool result to `messages` in place.
 * Return a separate result for a model error or a user cancellation.
 */
export async function agentLoop(state: State, permissionCheck: PermissionCheck, signal?: AbortSignal): Promise<AgentLoopResult> {
    let messages = state.messages;
    while (true) {
        state.loopCount++;
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
            // Record usage before the cancellation check can discard the response.
            await applyModelResponse(response, state);
        } catch (e) {
            if (signal?.aborted) return { stop_reason: "cancelled" };
            return {error: e, stop_reason: "model_error"};
        }
        // A cancellation can occur as the model request ends.
        if (signal?.aborted) return { stop_reason: "cancelled" };
        // Keep the response before its tool results in the message history.
        messages.push(response);

        const toolCalls = response.content.filter((item): item is ToolCall | InvalidToolCall => item.type === "toolCall");
        if (toolCalls.length > 0) {
            // Run the tool calls in the order of the response.
            for (let call of toolCalls) {
                let output = "";
                // Keep a result for each call, even if cancellation prevents its execution.
                if (signal?.aborted) {
                    output = "Tool execution cancelled before it started.";
                } else if ("argumentError" in call) {
                    // Report the parse error without hooks, permission checks, or tool execution.
                    output = call.argumentError;
                } else {
                    try {
                        // Check cancellation after hooks and permission prompts too.
                        call = await applyPreToolUse(call);
                        signal?.throwIfAborted();
                        let finding: Finding = await permissionCheck(call, signal);
                        signal?.throwIfAborted();
                        if (finding.permission === "allow") {
                            output = await runTool(call, state, signal);
                        } else {
                            output = finding.permission + ": " + finding.message;
                        }
                        if (!signal?.aborted) output = await applyPostToolUse(call, output);
                    } catch (error) {
                        if (!signal?.aborted) throw error;
                        output = "Tool execution cancelled.";
                    }
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
            await applyStop(response, state);
            return {message: response, stop_reason: "completed"};
        }
    }
}


