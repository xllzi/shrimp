# Agent traces

Shrimp can record metadata about each agent attempt as JSON Lines. Tracing is off by default. To enable it for a CLI session, run this command from the project directory:

```sh
SHRIMP_TRACE=1 npm run dev
```

`npm run dev` loads `.env`. At the prompt, enter a request. Enter `:q` to exit. Press `Ctrl+C` to cancel an active turn. For tool approval, see [Tool permissions](bash-permission-gate.md#approval-and-cancellation).

The CLI writes one file per attempt to `.artifacts/traces/<attempt_id>.jsonl`, relative to the process working directory. An attempt is one call to `agentLoop`, which can contain multiple model rounds and tool calls. Each line is a JSON event. A new attempt gets a new UUID, even in the same CLI session.

## Events

Every event has `type`, `attempt_id`, `sequence`, and `timestamp`. The sequence starts at 1 and increases within an attempt. The timestamp is an ISO 8601 UTC string. Durations use a monotonic clock and are in milliseconds.

| Event | Additional fields |
| --- | --- |
| `run.started` | `model`: configured model name. |
| `run.finished` | `duration_ms`, `stop_reason`. |
| `model.started` | `round`: model request number, starting at 1 for each attempt. |
| `model.finished` | `round`, `duration_ms`, `status`, and `usage` when a response exists. |
| `tool.started` | `round`, `tool_call_id`, `tool_name`. |
| `tool.finished` | `round`, `tool_call_id`, `tool_name`, `duration_ms`, `status`. |

`usage` contains `input_tokens`, `output_tokens`, and `cache_read_tokens` for that response. A run stop reason is `completed`, `cancelled`, `model_error`, or `error`. A model status is `completed`, `cancelled`, or `error`. A tool status is `completed`, `cancelled`, `denied`, `invalid_arguments`, `timeout`, or `error`.

Use `attempt_id` and `sequence` to order events within an attempt. Use `round` to associate a tool call with the model response that requested it, and `tool_call_id` to match its start and finish. A `tool.finished` duration includes the tool lifecycle, including permission checks and hooks. A failed write or an interrupted process can leave an incomplete trace.

## Scope and failures

The trace records metadata, not prompts, reply text, tool arguments, or tool results. It includes the model and tool names, identifiers, timings, statuses, and token counts. It can help compare attempts and find failures or slow steps, but it cannot by itself evaluate answer quality or reconstruct a conversation.

The trace sink is separate from the `onOutput` callback that streams text and tool status to the terminal. See [Streaming output](streaming-output.md). If a trace file operation fails, the CLI writes one warning to stderr and disables further trace writes for the session. The agent continues; earlier trace files can be incomplete.
