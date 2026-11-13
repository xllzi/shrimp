import { randomUUID } from "node:crypto";
import type { InvalidToolCall, ToolCall, Usage } from "../domain/agent.ts";
import type { ToolCallStatus } from "./tools.ts";

export type RunStopReason = "completed" | "cancelled" | "model_error" | "error";

type ToolTraceFields = { round: number; tool_call_id: string; tool_name: string };

type TraceEventData =
    | { type: "run.started"; model: string }
    | { type: "run.finished"; duration_ms: number; stop_reason: RunStopReason }
    | { type: "model.started"; round: number }
    | { type: "model.finished"; round: number; duration_ms: number; status: "completed" | "cancelled" | "error"; usage?: Usage }
    | ({ type: "tool.started"; arguments: ToolCall["arguments"] | InvalidToolCall["rawArguments"] } & ToolTraceFields)
    | ({ type: "tool.finished"; duration_ms: number; status: ToolCallStatus } & ToolTraceFields);

export type TraceEvent = TraceEventData & {
    attempt_id: string;
    sequence: number;
    timestamp: string;
};

export type TraceSink = (event: TraceEvent) => void;
export type EmitTrace = (event: TraceEventData) => void;

/** All events in a run have the same attempt ID. The sequence number increases for each event. */
export function createRunTrace(sink: TraceSink): EmitTrace {
    const attempt_id = randomUUID();
    let sequence = 0;
    return event => sink({ ...event, attempt_id, sequence: ++sequence, timestamp: new Date().toISOString() });
}
