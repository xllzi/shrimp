import type { AssistantMessage, State } from "../domain/agent.ts";

/** Add the usage from one model response to the totals in the supplied state. */
export function countTokenUsage(response: AssistantMessage, state: State) {
    state.usage.input_tokens += response.usage.input_tokens;
    state.usage.output_tokens += response.usage.output_tokens;
    state.usage.cache_read_tokens += response.usage.cache_read_tokens;
}

/** Print the current token totals and loop count. */
export async function summaryTurn(response: AssistantMessage, state: State) {
    console.log(`
    input tokens: ${state.usage.input_tokens}
    output tokens: ${state.usage.output_tokens}
    cache read tokens: ${state.usage.cache_read_tokens}
    loop count: ${state.loopCount}`)
}
