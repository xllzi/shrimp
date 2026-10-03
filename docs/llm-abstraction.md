# LLM abstraction

`src/llm.ts` defines the message format that the agent loop stores in its history. The adapters convert between this format and each provider's API.

## Contract

| Type | Purpose |
| --- | --- |
| `ModelConfig` | Selects `openai-responses` or `anthropic-messages`, names the model, and optionally sets `maxOutputTokens`. |
| `Message` | Represents a user message, an assistant message, or a tool result in the agent history. |
| `LlmRequest` | Carries the model, message history, optional system prompt, and optional tool definitions. |
| `LlmAdapter` | Takes one `LlmRequest` and returns one `AssistantMessage`. |

An assistant message can contain text, a refusal, thinking, redacted thinking, and tool calls. A tool call stores its ID, name, and object arguments. A tool result refers to that ID through `toolCallId`.

`createLlmStream` selects an adapter through `request.model.api`. The default `llmStream` uses `LLM_ADAPTERS` and returns a complete assistant message.

The OpenAI adapter prints streamed text before it returns that message. The Anthropic adapter waits for a complete response. See [Streaming output](streaming-output.md) for the OpenAI event actions.

## Request path

`src/main.ts` adds a user message to the history and calls `llmStream`. The selected adapter converts the history and tool definitions, then calls its provider. It converts the provider response into one `AssistantMessage`.

The agent loop adds that message to the history. It runs each tool call through hooks and the permission check, then adds a tool result. The loop calls the model again until the assistant returns no tool calls. The adapters do not run tools or change the history.

## Provider conversions

| Provider | History to request | Response to message |
| --- | --- | --- |
| OpenAI Responses | `messageToResponseInput` converts each `Message` into input items. | `responseOutputToMessage` converts reasoning, assistant text, refusals, and function calls. |
| Anthropic Messages | `messageToAnthropicMessages` converts the history and groups adjacent tool results into one user message. | `anthropicMessageToMessage` converts text, thinking, redacted thinking, and tool use. |

OpenAI reasoning stores its provider item in `thinkingSignature`. Anthropic thinking stores its signature there. `thinkingApi` identifies the provider that made the thinking block. Each converter sends a thinking block back only to its matching provider. OpenAI conversion also requires a valid stored reasoning item.

The converters do not preserve every provider content type. User messages and tool results contain text only. An OpenAI refusal becomes assistant text in Anthropic history. Provider-specific thinking from the other API does not enter the request.

`src/tools.ts` supplies provider-neutral tool definitions. `parseToolArguments` requires provider tool arguments to decode to an object. Each tool handler checks its own argument schema before it uses the arguments.

## Tests

`src/llm.test.ts` checks both conversion paths with provider-shaped data. It passes fake adapters to `createLlmStream` to check selection without a live provider call. Run `npm test` and `npm run check` after a conversion change.
