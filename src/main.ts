import OpenAI from "openai"
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import readline from "node:readline/promises";
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
    read_file: runReadFile,
    write_file: runWriteFile,
    edit_file: runEditFile,
};

async function runBash({commands}: {commands: string}): Promise<string> {
    const run = promisify(execFile);
    const output = await run(
        "bash", ["-c", commands],
        {timeout: 30_000, maxBuffer: 10*1024*1024},
    );
    return output.stdout;
}

async function runReadFile({filePath}: {filePath: string}): Promise<string> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (err) {
        return String(err);
    }
}

async function runWriteFile({filePath, content}: {filePath: string, content: string}): Promise<string> {
    try {
        await writeFile(filePath, content);
    } catch (err) {
        return String(err);
    }
    return "write file successfully";
}

async function runEditFile({filePath, oldText, newText}:
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
 * allow: safe read, no write, no shell
 * ask: risky local changes
 * deny: dangerous operation
 */
type Permission = "allow" | "ask" | "deny";

interface PermissionRule {
    tools: string[],
    check: Function,
    message: string,
    permission: Permission,
}

const PERMISSION_RULES: PermissionRule[] = [
    {
        tools: ["bash"],
        check: inDenyList,
        message: "Includes command in deny list\n",
        permission: "deny"
    },
    {
        tools: ["write_file", "edit_file"],
        check: outOfWorkspace,
        message: "Writing file outside workspace\n",
        permission: "ask"
    }
];

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot",
    "mkfs", "dd if=", "> /dev"];

function inDenyList(toolCall: Responses.ResponseFunctionToolCall): boolean {
    let args = JSON.parse(toolCall.arguments);
    for (let d of DENY_LIST) {
        if (args.commands.includes(d)) {
            return true;
        }
    }
    return false;
}

function outOfWorkspace(toolCall: Responses.ResponseFunctionToolCall): boolean {
    let args = JSON.parse(toolCall.arguments);
    let dir = path.dirname(args.filePath);
    if (process.cwd() === "/") return false;
    while (dir !== "/") {
        if (dir === process.cwd()) {
            return false;
        }
        dir = path.dirname(dir);
    }
    return true;
}

async function askPermission(toolCall: Responses.ResponseFunctionToolCall): Promise<Permission> {
    console.log("tool call: ", toolCall.name);
    console.log(toolCall.arguments);
    let permission!: Permission;
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })
    while (permission === undefined) {
        const answer = await rl.question("Approve this tool call? [y/n]");
        if (answer === 'y') permission = "allow";
        else if (answer === 'n') permission = "deny";
        else console.log("input y or n");
    }
    rl.close();
    return permission;
}

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
                    if (rule.tools.includes(call.name) && rule.check(call)) {
                        permission = rule.permission
                        output += permission + ": " + rule.message;
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
                        output = JSON.stringify(await fn(args));
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

main();
