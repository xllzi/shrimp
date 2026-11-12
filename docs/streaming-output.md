# Streaming output

The model adapters in [src/adapter/llm.ts](../src/adapter/llm.ts) send reply text fragments and text block boundaries to the optional `LlmRequest.onText` callback. Each adapter also returns one complete `AssistantMessage`. The agent loop uses that message for history and tool execution.

## Model events

| Provider event | Callback event |
| --- | --- |
| OpenAI `response.output_text.delta` | `text.delta` with the fragment. |
| OpenAI `response.output_text.done` | `text.end` for the completed text block. |
| Anthropic `content_block_start` with a non-empty text block | `text.delta` with the initial text. |
| Anthropic `content_block_delta` with `text_delta` | `text.delta` with the fragment. |
| Anthropic `content_block_stop` for a text block | `text.end` for the completed text block. |

OpenAI `response.completed` supplies the complete output and usage. Anthropic `message_stop` triggers `finalMessage()`, which supplies the complete message and usage. The adapters keep thinking and tool calls in the complete message. Only reply text goes through the callback.

OpenAI's `error` event and SDK errors reject the request. If the stream ends before the completion event, the adapter throws `Stream ended without a completed response`.

## Terminal rendering

`agentLoop` forwards text events and tool completion status to its optional `onOutput` callback. [The CLI](../src/adapter/cli.ts) prints each text fragment as it arrives and ends the line when the block closes. It prints one line with the tool name and status after each call. The model receives the complete tool result in its history.

A caller can omit `onOutput` to skip regular terminal output. Hook and trace write errors go to stderr. The [JSONL trace](agent-traces.md) records metadata through its own callback.
