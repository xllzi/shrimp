import OpenAI from "openai"
import type { Responses } from "openai/resources/responses";
import readline from "node:readline/promises";
import { Permission, RANK, PERMISSION_RULES, askPermission, bashVerdict } from "./permission.ts";
import { TOOLS, TOOL_HANDLERS } from "./tools.ts";
import { applyUserPromptSubmit, applyPreToolUse, applyPostToolUse, applyStop } from "./hooks.ts";
import { permissionCheck } from "./permission.ts";

// init a client
const client = new OpenAI();

/**
 * A ReAct Agent Loop
 */
async function agentLoop(message: Responses.ResponseInput) {
    console.log("-----context-----");
    console.log(message);
    while (true) {
        // call LLM
        const response: Responses.Response = await client.responses.create({
            model: "qwen3.8-27b",
            instructions: "You are a thinking machine.",
            input: message,
            tools: TOOLS,
        })
        message.push(...response.output as Responses.ResponseInputItem[]);
        console.log("-----LLM response-----");
        console.log(response.output);

        let toolCalls = response.output.filter((item) => (item.type === "function_call"));
        if (toolCalls.length > 0) {
            // run each tool calls
            for (let call of toolCalls) {
                let output = ""; // tool output passed back to LLM
                // hooks may rewrite the call; permission then checks what will actually run
                call = await applyPreToolUse(call);
                let finding = await permissionCheck(call);
                if (finding.permission === "allow") {
                    output = await runTool(call);
                } else {
                    output = finding.permission + ": " + finding.message;
                }
                // construct function call output
                output = await applyPostToolUse(call, output);
                let callOutput: Responses.ResponseInputItem.FunctionCallOutput = {
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": output,
                }
                // push function call output back to message list
                message.push(callOutput as Responses.ResponseInputItem);
                console.log("-----function call output-----");
                console.log(callOutput.output);
            }
        } else {
            await applyStop(response);
            return response;
        }
    }
}

async function runTool(call: Responses.ResponseFunctionToolCall): Promise<string> {
    let output: string;
    // dispatch function and executed
    let fn = TOOL_HANDLERS[call.name];
    let args = JSON.parse(call.arguments);
    try {
        output = await fn(args);
    } catch (error) {
        output = String(error);
    }
    return output;
}
/**
 * main entry point
 */
async function main() {
    let query = "";
    let history: Responses.ResponseInput = [];
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })
    while (1) {
        query = await rl.question("> ");
        if (query === ":q") break;
        query = await applyUserPromptSubmit({ query, history });
        history.push({role: "user", content: query});
        const response = await agentLoop(history);
        console.log("-----LLM reply-----");
        console.log(response.output_text);
    }
    rl.close();
}

// `--check '<commands>'` tests the permission gate without talking to the LLM
if (process.argv[2] === "--check") {
    const verdict = bashVerdict(process.argv[3] ?? "");
    console.log(verdict === null ? "allow" : `${verdict.permission}: ${verdict.message}`);
} else {
    main();
}
