import OpenAI from "openai"
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Responses } from "openai/resources/responses";


// init a client
const client = new OpenAI();

// define a tool set
const TOOLS: Responses.Tool[] = [{
    "type": "function",
    "name": "bash",
    "description": "run bash commands",
    "parameters": {
      "type": "object",
      "properties": { "commands": { "type": "array", "items": {"type": "string"} } },
      "required": ["commands"],
      "additionalProperties": false
    },
    "strict": true,
}];

async function runBash(commands: string) {
    // detect dangerous commands
    let dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    for (let d of dangerous) {
        if (commands.includes(d)) {
            return "Error: Dangerous operation";
        }
    }

    const run = promisify(execFile);
    const output = await run(
        "bash", ["-c", commands],
        {timeout: 30_000, maxBuffer: 10*1024*1024},
    );
    return output;
}

/**
 * A ReAct Agent Loop
 */
async function agentLoop(message: Responses.ResponseInput) {
    while (true) {
        // call LLM
        const response: Responses.Response = await client.responses.create({
            model: "qwen3.8-27b",
            instructions: "You are a helpful assistant.",
            input: message,
            tools: TOOLS,
        })
        message.push(...response.output as Responses.ResponseInputItem[]);

        let toolCalls = response.output.filter((item) => (item.type === "function_call"));
        if (toolCalls.length > 0) {
            // run each tool calls
            for (let call of toolCalls) {
                var output: string;
                try {
                    output = JSON.stringify(await runBash(JSON.parse(call.arguments).commands));
                } catch (error) {
                    output = String(error);
                }
                let callOutput: Responses.ResponseInputItem.FunctionCallOutput = {
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": output,
                }
                // push function call output back to message list
                message.push(callOutput as Responses.ResponseInputItem);
            }
        } else {
            return response;
        }
        console.log(message);
    }
}


let query = "run a bash command only once";
let history: Responses.ResponseInput = [{role: "user", content: query}];
const response = await agentLoop(history);
console.log(response.output_text);
history.push(...response.output as Responses.ResponseInputItem[]);
