import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

// These schemas define the tool parameters and check arguments before execution.
const BashSchema = z.object({
    commands: z.string(),
})

const ReadFileSchema = z.object({
    filePath: z.string(),
})

const WriteFileSchema = z.object({
    filePath: z.string(),
    content: z.string(),
})

const EditFileSchema = z.object({
    filePath: z.string(),
    oldText: z.string().min(1, "'oldText' must not be empty."),
    newText: z.string(),
})

const ToolArgumentsSchema = z.record(z.string(), z.unknown());

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: { type: "object"; [key: string]: unknown };
}

/**
 * Parse the JSON arguments from the provider. Reject values other than objects.
 * The message converter catches parse errors and keeps the call for an error result.
 */
export function parseToolArguments(name: string, argumentsJson: string): Record<string, unknown> {
    let json: unknown;
    try {
        json = JSON.parse(argumentsJson);
    } catch (error) {
        throw new Error(`Invalid JSON arguments for ${name}: ${String(error)}`);
    }

    const parsed = ToolArgumentsSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
}

// The model uses these definitions to select tools and supply arguments.
export const TOOL_DEFINITIONS: ToolDefinition[] = [
    { name: "bash", 
      description: "run bash commands", 
      parameters: z.toJSONSchema(BashSchema) as ToolDefinition["parameters"] 
    },
    { name: "read_file", 
      description: "read a file's content",
      parameters: z.toJSONSchema(ReadFileSchema) as ToolDefinition["parameters"] 
    },
    { name: "write_file", 
      description: "write content to a file",
      parameters: z.toJSONSchema(WriteFileSchema) as ToolDefinition["parameters"] 
    },
    { name: "edit_file",
      description: "Replace text in a file. The 'oldText' value must match exactly once.",
      parameters: z.toJSONSchema(EditFileSchema) as ToolDefinition["parameters"] 
    },
];

export type ToolFn = (...arg: any) => string | Promise<string>; 
// The agent uses the tool name to select a function from this table.
export const TOOL_HANDLERS: Record<string, ToolFn> = {
    bash: runBash,
    read_file: runReadFile,
    write_file: runWriteFile,
    edit_file: runEditFile,
};

async function runBash(args: unknown): Promise<string> {
    const res = BashSchema.safeParse(args);
    if (!res.success) {
        return `bash parameters verification fail: ${z.prettifyError(res.error)}`;
    }
    let commands = res.data.commands;
    const run = promisify(execFile);
    // Limit the process to 30 seconds and each output buffer to 10 MiB.
    const output = await run(
        "bash", ["-c", commands],
        {timeout: 30_000, maxBuffer: 10*1024*1024},
    );
    // Return only the standard output. Process errors reject the promise.
    return output.stdout;
}

async function runReadFile(args: unknown): Promise<string> {
    const res = ReadFileSchema.safeParse(args);
    if (!res.success) {
        return `read_file parameters verification fail: ${z.prettifyError(res.error)}`;
    }
    let filePath = res.data.filePath;
    try {
        return await readFile(filePath, 'utf8');
    } catch (err) {
        return String(err);
    }
}

async function runWriteFile(args: unknown): Promise<string> {
    const res = WriteFileSchema.safeParse(args);
    if (!res.success) {
        return `write_file parameter verification fail: ${z.prettifyError(res.error)}`;
    }
    let filePath = res.data.filePath;
    let content = res.data.content;
    try {
        // Create the file or replace all its content.
        await writeFile(filePath, content);
    } catch (err) {
        return String(err);
    }
    return "write file successfully";
}

async function runEditFile(args: unknown): Promise<string> {
    const res = EditFileSchema.safeParse(args);
    if (!res.success) {
        return `Error: Invalid \`edit_file\` arguments: ${z.prettifyError(res.error)}`;
    }
    let filePath = res.data.filePath;
    let oldText = res.data.oldText;
    let newText = res.data.newText;
    try {
        const text = await readFile(filePath, 'utf8');
        const matchStart = text.indexOf(oldText);
        if (matchStart === -1) {
            return "Error: The content does not contain `oldText`. Before you retry, use `read_file`.";
        }
        // Reject a second match, including a match that overlaps the first one.
        if (text.indexOf(oldText, matchStart + 1) !== -1) {
            return "Error: The content contains `oldText` more than one time. Add more context to `oldText`.";
        }
        // Insert the replacement text as literal content.
        const updatedText = text.slice(0, matchStart) + newText + text.slice(matchStart + oldText.length);
        await writeFile(filePath, updatedText);
    } catch (err) {
        return String(err);
    }
    return "replace file successfully";
}
