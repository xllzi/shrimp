import type { AssistantMessage, Message, State, ToolCall } from "../domain/agent.ts";

/** Loop state a prompt handler can see. */
export type UserPromptCtx = {
    query: string;
    history: Message[];
};

// --- registries: one per point, each with its own contract ------------

const userPromptHooks: Array<(ctx: UserPromptCtx) => string | Promise<string>> = [];
const modelResponseHooks: Array<(response: AssistantMessage, state: State) => void | Promise<void>> = []
const preToolHooks: Array<(call: ToolCall) => ToolCall | Promise<ToolCall>> = [];
const postToolHooks: Array<(call: ToolCall, output: string) => string | Promise<string>> = [];
const stopHooks: Array<(response: AssistantMessage, state: State) => void | Promise<void>> = [];

export function onUserPromptSubmit(fn: (ctx: UserPromptCtx) => string | Promise<string>) {
    userPromptHooks.push(fn);
}

export function onModelResponse(fn: (response: AssistantMessage, state: State) => void | Promise<void>) {
    modelResponseHooks.push(fn);
}

export function onPreToolUse(fn: (call: ToolCall) => ToolCall | Promise<ToolCall>) {
    preToolHooks.push(fn);
}

export function onPostToolUse(fn: (call: ToolCall, output: string) => string | Promise<string>) {
    postToolHooks.push(fn);
}

export function onStop(fn: (response: AssistantMessage, state: State) => void | Promise<void>) {
    stopHooks.push(fn);
}


// --- dispatch: one function per point ---------------------------------
// Chain points pass value through every handler in registration order.
// If a hook fails, log the error and continue with the next hook.

export async function applyUserPromptSubmit(ctx: UserPromptCtx): Promise<string> {
    let query = ctx.query;
    for (const hook of userPromptHooks) {
        try {
            query = await hook({ ...ctx, query });
        } catch (err) {
            console.error(`[hook UserPromptSubmit] ${err}`);
        }
    }
    return query;
}

/** Run hooks in registration order. Each hook receives the same state object. */
export async function applyModelResponse(response: AssistantMessage, state: State): Promise<void> {
    for (const hook of modelResponseHooks) {
        try {
            await hook(response, state);
        } catch (err) {
            console.error(`[hook modelResponse] ${err}`);
        }
    }
}

export async function applyPreToolUse(call: ToolCall): Promise<ToolCall> {
    for (const hook of preToolHooks) {
        try {
            call = await hook(call);
        } catch (err) {
            console.error(`[hook PreToolUse] ${err}`);
        }
    }
    return call;
}

export async function applyPostToolUse(call: ToolCall, output: string): Promise<string> {
    for (const hook of postToolHooks) {
        try {
            output = await hook(call, output);
        } catch (err) {
            console.error(`[hook PostToolUse] ${err}`);
        }
    }
    return output;
}

/** Run hooks after the final response. Wait for each hook to finish. */
export async function applyStop(response: AssistantMessage, state: State): Promise<void> {
    for (const hook of stopHooks) {
        try {
            await hook(response, state);
        } catch (err) {
            console.error(`[hook Stop] ${err}`);
        }
    }
}
