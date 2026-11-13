# LLM abstraction

`src/domain/agent.ts` defines the message format that the agent loop stores in its history. The adapters in `src/adapter/llm.ts` convert between this format and each provider's API.

## Contract

| Type | Purpose |
| --- | --- |
| `ModelConfig` | Selects `openai-responses` or `anthropic-messages`, names the model, and optionally sets `maxOutputTokens`. |
| `Message` | Represents a user message, an assistant message, or a tool result in the agent history. |
| `LlmRequest` | Carries the model, history, and optional system prompt and tool definitions. |
| `LlmCallOptions` | Carries an optional cancellation signal and text callback for this call. |
| `LlmAdapter` | Takes a `LlmRequest` and optional `LlmCallOptions`. Returns one `AssistantMessage`. |

An assistant message can contain text, a refusal, thinking, redacted thinking, and tool calls. A tool call stores its ID, name, and object arguments. A tool result refers to that ID through `toolCallId`.

`createLlmStream` selects an adapter through `request.model.api`. The default `llmStream` uses `LLM_ADAPTERS` and returns a complete assistant message.

Call `llmStream(request, { signal, onText })` to pass a cancellation signal or receive reply and thinking fragments. The second argument is optional. See [Streaming output](streaming-output.md) for the event mapping and terminal rendering.

## Request path

The CLI adds a user message to the history and calls `agentLoop`. The agent loop calls `llmStream`. The selected adapter converts the history and tool definitions, then calls its provider. It converts the provider response into one `AssistantMessage`.

The agent loop adds that message to the history. It runs each tool call through hooks and the permission check, then adds a tool result. The loop calls the model again until the assistant returns no tool calls. The adapters do not run tools or change the history.

## Provider conversions

| Provider | History to request | Response to message |
| --- | --- | --- |
| OpenAI Responses | `messageToResponseInput` converts each `Message` into input items. | `responseOutputToMessage` converts reasoning, assistant text, refusals, and function calls. |
| Anthropic Messages | `messageToAnthropicMessages` converts the history and groups adjacent tool results into one user message. | `anthropicMessageToMessage` converts text, thinking, redacted thinking, and tool use. |

OpenAI reasoning stores its provider item in `thinkingSignature`. Anthropic thinking stores its signature there. `thinkingApi` identifies the provider that made the thinking block. Each converter sends a thinking block back only to its matching provider. OpenAI conversion also requires a valid stored reasoning item.

The converters do not preserve every provider content type. User messages and tool results contain text only. An OpenAI refusal becomes assistant text in Anthropic history. Provider-specific thinking from the other API does not enter the request.

`src/domain/tools.ts` supplies provider-neutral tool definitions. `parseToolArguments` requires provider tool arguments to decode to an object. Each tool handler checks its own argument schema before it uses the arguments.

## Tests

`src/adapter/llm.test.ts` checks both conversion paths with provider-shaped data. It passes fake adapters to `createLlmStream` to check selection without a live provider call. Run `npm test` and `npm run check` after a conversion change.
