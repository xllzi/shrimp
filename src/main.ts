import OpenAI from "openai"
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// init a client
const client = new OpenAI();

// define a tool set
const TOOLS = [{
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

async function runBash(commands) {
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
        {timout: 30_000, maxBuffer: 10*1024*1024},
    );
    return output;
}

/**
 * A ReAct Agent Loop
 */
async function agentLoop(message) {
    while (true) {
        // call LLM
        const response = await client.responses.create({
            model: "qwen3.8-flash",
            instructions: "You are a helpful assistant.",
            input: message,
            enable_thinking: true,
            tools: TOOLS,
        })
        message.push(...response.output);

        let toolCalls = response.output.filter((item) => (item.type === "function_call"));
        if (toolCalls.length > 0) {
            // run each tool calls
            for (let call of toolCalls) {
                var output;
                try {
                    output = JSON.stringify(await runBash(JSON.parse(call.arguments).commands));
                } catch (error) {
                    output = error;
                }
                let callOutput = {
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": output,
                }
                message.push(callOutput);
            }
        } else {
            return response.output_text;
        }
        console.log(message);
    }
}


let query = "run a bash command only once";
let history: ResponseInput = [{role: "user", content: query}];
const response = await agentLoop(history);
console.log(response);
history.push(response.output);
