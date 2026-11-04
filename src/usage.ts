import { llmStream, type AssistantMessage } from "./llm.ts";
import type { State } from "./agent.ts";

/** Add the usage from one model response to the totals in the supplied state. */
export function countTokenUsage(response: AssistantMessage, state: State) {
    state.usage.input_tokens += response.usage.input_tokens;
    state.usage.output_tokens += response.usage.output_tokens;
    state.usage.cache_read_tokens += response.usage.cache_read_tokens;
}

