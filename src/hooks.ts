import { permissionCheck } from "./permission.ts";
import { contextInject } from "./context.ts";

const HOOKS: Record<string, Array<Function>> = {
    "UserPromptSubmit": [],
    "PreToolUse": [permissionCheck],
    "PostToolUse": [],
    "Stop": [],
};

export async function triggerHook(event: string, ...args: any): Promise<any> {
    for (let callback of HOOKS[event]) {
        let result = await callback(args);
        if (result !== undefined) {
            return result;
        }
    }
    return undefined;
}

export function registerHook(event: string, fn: Function) {
    HOOKS[event].push(fn);
}
