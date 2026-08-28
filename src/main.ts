import OpenAI from "openai"
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
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
      "properties": { "commands": { "type": "string" } },
      "required": ["commands"],
      "additionalProperties": false
    },
    "strict": true,
},
{
    "type": "function",
    "name": "read_file",
    "description": "read a file content",
    "parameters": {
        "type": "object",
        "properties": { "filePath": { "type": "string" } },
        "required": ["filePath"],
        "additionalProperties": false
    },
    "strict": true,
},
{
    "type": "function",
    "name": "write_file",
    "description": "write content to a file",
    "parameters": {
        "type": "object",
        "properties": { "filePath": { "type": "string"},
                        "content": { "type": "string"} },
        "required": ["filePath", "content"],
        "additionalProperties": false
    }, 
    "strict": true,
},
{
    "type": "function",
    "name": "edit_file",
    "description": "replace text in file",
    "parameters": {
        "type": "object",
        "properties": { "filePath": { "type": "string" },
                        "oldText": { "type": "string" },
                        "newText": { "type": "string" } },
        "required": ["filePath", "oldText", "newText"],
        "additionalProperties": false
    },
    "strict": true,
}];

// map tool to function and dispatch correspondingly
type ToolFn = (...args: any) => string | Promise<string>; 
const TOOL_HANDLERS: Record<string, ToolFn> = {
    bash: runBash,
    read_file: runRead,
    write_file: runWrite,
    edit_file: runEdit,
};

async function runBash({commands}: {commands: string}): Promise<string> {
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
    return output.stdout;
}

async function runRead({filePath}: {filePath: string}): Promise<string> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (err) {
        return String(err);
    }
}

async function runWrite({filePath, content}: {filePath: string, content: string}): Promise<string> {
    try {
        await writeFile(filePath, content);
    } catch (err) {
        return String(err);
    }
    return "write file successfully";
}

async function runEdit({filePath, oldText, newText}:
                       {filePath: string, oldText: string, newText: string}): Promise<string> {
    try {
        const text = await readFile(filePath, 'utf8');
        await writeFile(filePath, text.replace(oldText, newText));
    } catch (err) {
        return String(err);
    }
    return "replace file successfully";
}
/**
 * A ReAct Agent Loop
 */
async function agentLoop(message: Responses.ResponseInput) {
    while (true) {
        // call LLM
        const response: Responses.Response = await client.responses.create({
            model: "qwen3.8-27b",
            instructions: "You are a thinking machine.",
            input: message,
            tools: TOOLS,
        })
        message.push(...response.output as Responses.ResponseInputItem[]);

        let toolCalls = response.output.filter((item) => (item.type === "function_call"));
        if (toolCalls.length > 0) {
            // run each tool calls
            for (let call of toolCalls) {
                var output: string;
                let fn = TOOL_HANDLERS[call.name];
                let args = JSON.parse(call.arguments);
                try {
                    output = JSON.stringify(await fn(args));
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
    }
}


let query = "write a simple hello-world C program and run it";
let history: Responses.ResponseInput = [{role: "user", content: query}];
const response = await agentLoop(history);
console.log(response.output_text);
console.log("----trajectory----");
console.log(history);
