import { type ModelConfig, llmStream } from "../adapter/llm.ts";
import type { AssistantMessage, InvalidToolCall, State, ToolCall, ToolResultMessage } from "../domain/agent.ts";
import { applyModelResponse, applyPostToolUse, applyPreToolUse, applyStop } from "./hooks.ts";
import { TOOL_DEFINITIONS } from "../domain/tools.ts";
import type { PermissionCheck } from "./permission.ts";
import { runTool, type ToolFailure } from "./tools.ts";
import { createRunTrace, type EmitTrace, type RunStopReason, type ToolTraceStatus, type TraceSink } from "./trace.ts";

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
export async function agentLoop(
    state: State,
    permissionCheck: PermissionCheck,
    signal?: AbortSignal,
    traceSink?: TraceSink,
): Promise<AgentLoopResult> {
    const trace = traceSink && createRunTrace(traceSink);
    // Use a monotonic clock to measure elapsed time.
    const startedAt = performance.now();
    trace?.({ type: "run.started", model: MODEL.model });
    let stopReason: RunStopReason = "error";
    try {
        const result = await runAgentLoop(state, permissionCheck, signal, trace);
        stopReason = result.stop_reason;
        return result;
    } finally {
        // Record the end of the run on return or when an error propagates.
        trace?.({ type: "run.finished", duration_ms: performance.now() - startedAt, stop_reason: stopReason });
    }
}

async function runAgentLoop(state: State, permissionCheck: PermissionCheck, signal?: AbortSignal, trace?: EmitTrace): Promise<AgentLoopResult> {
    const messages = state.messages;
    let round = 0;
    while (true) {
        state.loopCount++;
        // After a cancellation, do not start another model request.
        if (signal?.aborted) return { stop_reason: "cancelled" };
        round++;
        let response: AssistantMessage | undefined;
        trace?.({ type: "model.started", round });
        const startedAt = performance.now();
        try {
            try {
                response = await llmStream({
                    model: MODEL,
                    systemPrompt: "You are a thinking machine.",
                    messages,
                    tools: TOOL_DEFINITIONS,
                    signal,
                });
            } finally {
                trace?.({
                    type: "model.finished",
                    round,
                    duration_ms: performance.now() - startedAt,
                    status: signal?.aborted ? "cancelled" : response ? "completed" : "error",
                    usage: response && { ...response.usage },
                });
            }
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
            for (const call of toolCalls) {
                const result = await executeToolCall(call, state, permissionCheck, signal, round, trace);
                messages.push(result);
                console.log("-----function call output-----");
                console.log(result.content[0]?.text);
            }
            // The next model request includes all tool results from this response.
        } else {
            // The loop stops normally only for a response without tool calls.
            await applyStop(response, state);
            return {message: response, stop_reason: "completed"};
        }
    }
}

async function executeToolCall(
    call: ToolCall | InvalidToolCall,
    state: State,
    permissionCheck: PermissionCheck,
    signal: AbortSignal | undefined,
    round: number,
    trace?: EmitTrace,
): Promise<ToolResultMessage> {
    const traceFields = { round, tool_call_id: call.id, tool_name: call.name };
    trace?.({ type: "tool.started", ...traceFields });
    const startedAt = performance.now();
    let status: ToolTraceStatus = "error";
    let output: string;
    try {
        // Keep a result for each call, even if cancellation prevents its execution.
        if (signal?.aborted) {
            status = "cancelled";
            output = "Tool execution cancelled before it started.";
        } else if ("argumentError" in call) {
            status = "invalid_arguments";
            output = call.argumentError;
        } else {
            call = await applyPreToolUse(call);
            signal?.throwIfAborted();
            const finding = await permissionCheck(call, signal);
            signal?.throwIfAborted();
            if (finding.permission === "allow") {
                let failure: ToolFailure | undefined;
                output = await runTool(call, state, signal, trace && (outcome => { failure = outcome; }));
                status = failure ?? "completed";
            } else {
                status = "denied";
                output = finding.permission + ": " + finding.message;
            }
            if (!signal?.aborted) output = await applyPostToolUse(call, output);
        }
    } catch (error) {
        if (!signal?.aborted) {
            status = "error";
            throw error;
        }
        status = "cancelled";
        output = "Tool execution cancelled.";
    } finally {
        trace?.({ type: "tool.finished", ...traceFields, duration_ms: performance.now() - startedAt, status });
    }
    return { role: "tool", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: output }] };
}

