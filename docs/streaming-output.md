# Streaming output

Pass `onText` in the optional second argument to `llmStream` to receive reply and thinking fragments and block boundaries. The [model adapters](../src/adapter/llm.ts) also return one complete `AssistantMessage`. The agent loop uses that message for history and tool execution.

## Model events

| Provider event | Callback event |
| --- | --- |
| OpenAI `response.output_text.delta` | `text.delta` with the fragment. |
| OpenAI `response.output_text.done` | `text.end` for the completed text block. |
| OpenAI `response.reasoning_text.delta` | `thinking.delta` with the fragment. |
| OpenAI `response.reasoning_text.done` | `thinking.end` for the completed reasoning text. |
| Anthropic `content_block_start` with a non-empty text block | `text.delta` with the initial text. |
| Anthropic `content_block_delta` with `text_delta` | `text.delta` with the fragment. |
| Anthropic `content_block_stop` for a text block | `text.end` for the completed text block. |
| Anthropic `content_block_start` with non-empty thinking text | `thinking.delta` with the initial thinking text. |
| Anthropic `content_block_delta` with `thinking_delta` | `thinking.delta` with the fragment. |
| Anthropic `content_block_stop` for a thinking block | `thinking.end` for the completed thinking block. |

OpenAI `response.completed` supplies the complete output and usage. Anthropic `message_stop` triggers `finalMessage()`, which supplies the complete message and usage. Thinking signatures, redacted thinking, and tool calls go into the complete message. The callback receives only readable text fragments and block boundaries.

OpenAI's `error` event and SDK errors reject the request. If the stream ends before the completion event, the adapter throws `Stream ended without a completed response`.

## Terminal rendering

`agentLoop` forwards text events and tool completion status to its optional `onOutput` callback. [The CLI](../src/adapter/cli.ts) prints `Thinking...` before the first non-empty fragment of each thinking block. It prints fragments as they arrive and ends the line when the block closes. It prints one line with the tool name and status after each call. The model receives the complete tool result in its history.

A caller can omit `onOutput` to skip regular terminal output. Hook and trace write errors go to stderr. The [JSONL trace](agent-traces.md) uses its own callback.
