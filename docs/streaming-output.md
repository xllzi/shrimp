# Streaming output

`openAIResponsesAdapter` in `src/llm.ts` calls `client.responses.create` with `stream: true`. It reads the response events with `for await`.

The adapter writes text to stdout before it converts the complete response into an `AssistantMessage`.

## Event actions

The table describes the current OpenAI adapter. Events without a matching branch pass through the loop without an action.

| Event or condition | Adapter action |
| --- | --- |
| `response.created`, `response.in_progress`, `response.queued` | Skip the event. Print nothing. |
| `response.output_item.added` with `event.item.type === "reasoning"` | Print a newline and `Thinking...`. Skip other item types. |
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
| `response.output_item.done` | Skip the event. Use the complete output from `response.completed` for conversion. |
| `response.function_call_arguments.delta`, `response.function_call_arguments.done` | Skip the events. Parse the complete tool arguments during final conversion. |
| `response.refusal.delta`, `response.refusal.done` | Skip the events. The final conversion preserves refusals, but the CLI does not display them. |
| `error` | Throw `new Error(event.message)`. This rejects the adapter's promise. |
| `response.failed`, `response.incomplete` | Skip the events. If the stream ends without completion, throw the fallback error described below. |
| `response.completed` | Print `Reponse completed.` after a newline. Return `responseOutputToMessage(event.response.output)`. |
| Other events | Skip the events. The adapter does not display audio, images, or events for provider built-in tools. |

The adapter prints reasoning text and assistant text. It does not print reasoning summaries, even if the provider sends summary events.

## Completion and errors

`response.completed` contains the complete response output. The adapter uses it to convert reasoning, text, refusals, and tool calls into one `AssistantMessage`.

The agent loop adds the message to history and executes any tool calls. It adds tool results and requests another response.
The main loop asks for the next user prompt after the agent loop returns a response without tool calls.
One completed model response does not necessarily finish the user's request.

If the event loop ends without `response.completed`, the adapter throws this error:

```text
Stream ended without a completed response
```

This prevents an implicit `undefined` return. Errors from the SDK or conversion also reject the adapter's promise.

The adapter has no separate branches for `response.failed` and `response.incomplete`.
Their error details and incomplete reasons do not appear in the fallback error.
