import OpenAI from "openai"
import type { Responses } from "openai/resources/responses";
import readline from "node:readline/promises";
import { Permission, RANK, PERMISSION_RULES, askPermission, bashVerdict } from "./permission.ts";
import { TOOLS, TOOL_HANDLERS } from "./tools.ts";

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
                // tool call go through permission gate
                let permission: Permission = "allow";
                for (let rule of PERMISSION_RULES) {
                    if (!rule.tools.includes(call.name)) continue;
                    const verdict = rule.check(call);
                    if (verdict && RANK[verdict.permission] > RANK[permission]) {
                        permission = verdict.permission;
                        output = permission + ": " + verdict.message + "\n";
                    }
                }
                if (permission === "ask") {
                    permission = await askPermission(call);
                    output += "user " + permission;
                }
                if (permission === "allow") {
                    // dispatch function and executed
                    let fn = TOOL_HANDLERS[call.name];
                    let args = JSON.parse(call.arguments);
                    try {
                        output = await fn(args);
                    } catch (error) {
                        output = String(error);
                    }
                }
                // construct function call output
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
            return response;
        }
    }
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
