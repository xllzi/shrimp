# Streaming output

Both adapters in `src/llm.ts` read response events with `for await` and write text fragments to stdout.

Each adapter returns one complete `AssistantMessage`. The agent loop uses that message for history and tool execution.

## OpenAI Responses

`openAIResponsesAdapter` calls `client.responses.create` with `stream: true`.

The table describes the current OpenAI adapter. Events without a matching branch pass through the loop without an action.

| Event or condition | Adapter action |
| --- | --- |
| `response.created`, `response.in_progress`, `response.queued` | Skip the event. Print nothing. |
| `response.output_item.added` with `event.item.type === "reasoning"` | Print `Thinking...` with a final newline. |
| `response.output_item.added` with `event.item.type === "message"` | Print `Responding...` with a final newline. Skip other item types. |
| `response.content_part.added` | Skip the event. It marks the start of a content part, such as reasoning text or assistant text. |
| `response.reasoning_summary_part.added` | Skip the event. The final conversion does not require a separate summary accumulator. |
| `response.reasoning_summary_text.delta` | Skip the event. Do not print summary text fragments. |
| `response.reasoning_summary_text.done` | Skip the event. Do not print the complete summary text. |
| `response.reasoning_summary_part.done` | Skip the event. Do not collect the complete summary part separately. |
| `response.reasoning_text.delta` | Use `process.stdout.write(event.delta)` to print each reasoning text fragment. |
| `response.reasoning_text.done` | Use `console.log()` to print a newline. Do not print the complete reasoning text again. |
| `response.output_text.delta` | Use `process.stdout.write(event.delta)` to print each assistant text fragment. |
| `response.output_text.done` | Skip the event. Do not print the complete assistant text again. |
| `response.content_part.done` | Skip the event. Do not collect the complete part separately. |
| `response.output_item.done` | Print a newline for every completed item. Use the complete output from `response.completed` for conversion. |
| `response.function_call_arguments.delta`, `response.function_call_arguments.done` | Skip the events. Parse the complete tool arguments during final conversion. |
| `response.refusal.delta`, `response.refusal.done` | Skip the events. The final conversion preserves refusals, but the CLI does not display them. |
| `error` | Throw `new Error(event.message)`. This rejects the adapter's promise. |
| `response.failed`, `response.incomplete` | Skip the events. If the stream ends without completion, throw the fallback error described below. |
| `response.completed` | Return `responseOutputToMessage(event.response.output)`. Print no completion label. |
| Other events | Skip the events. The adapter does not display audio, images, or events for provider built-in tools. |

The adapter prints reasoning text and assistant text. It does not print reasoning summaries, even if the provider sends summary events.

### Completion and errors

`response.completed` contains the complete response output. The adapter uses it to convert reasoning, text, refusals, and tool calls into one `AssistantMessage`.

If the event loop ends without `response.completed`, the adapter throws this error:

```text
Stream ended without a completed response
```

This prevents an implicit `undefined` return. Errors from the SDK or conversion also reject the adapter's promise.

The adapter has no separate branches for `response.failed` and `response.incomplete`.
Their error details and incomplete reasons do not appear in the fallback error.

## Anthropic Messages

`anthropicMessagesAdapter` calls `client.messages.stream()`. This SDK helper collects the events into a complete provider message.

| Event or condition | Adapter action |
| --- | --- |
| `message_start` | Print nothing. The SDK starts the message snapshot. |
| `content_block_start` with `event.content_block.type === "thinking"` | Print `Thinking...` with a final newline. |
| `content_block_start` with `event.content_block.type === "text"` | Print `Responding...` with a final newline. Skip other block types. |
| `content_block_delta` with `event.delta.type === "thinking_delta"` | Print the fragment with `process.stdout.write(event.delta.thinking)`. |
| `content_block_delta` with `event.delta.type === "text_delta"` | Print the fragment with `process.stdout.write(event.delta.text)`. |
| `content_block_delta` with `event.delta.type === "signature_delta"` | Print nothing. The SDK stores the thinking signature. |
| `content_block_delta` with `event.delta.type === "input_json_delta"` | Print nothing. The SDK collects the tool arguments for the final message. |
| `content_block_stop` | Print a newline for every completed block. |
| `message_delta` | Print nothing. The SDK updates message metadata and token usage. |
| `message_stop` | Await `response.finalMessage()`. Return `anthropicMessageToMessage()` with that complete message. |
| Other events | Take no action in the adapter loop. |

The adapter displays thinking only when the provider sends thinking blocks. The current request does not set a `thinking` option.

### Completion and errors

`message_stop` marks the end of the message. It does not contain the complete message content.
The adapter gets that content through `response.finalMessage()`.

`anthropicMessageToMessage` converts text, thinking, redacted thinking, and tool calls into one `AssistantMessage`.
The conversion preserves thinking signatures and parses complete tool arguments.
The adapter does not print the complete message again.

The Anthropic API can send an SSE `error` event with this JSON data:

```json
{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

The SDK converts this event into an `APIError` before the adapter loop receives it.
The loop throws that error instead of yielding an event with `type: "error"`.
The adapter does not need an `event.type === "error"` branch.

The adapter catches errors from iteration, `finalMessage()`, or conversion.
It prints `Anthropic stream failed` to stderr and throws the same error again.
Client creation and stream setup occur before the `try` block. Errors from those operations also reject the adapter promise.

If the loop ends without `message_stop`, the adapter throws this error:

```text
Stream ended without a completed response
```
