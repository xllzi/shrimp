import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import type { Responses } from "openai/resources/responses";
import { z } from "zod";
import { zodResponsesFunction } from "openai/helpers/zod"

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
    oldText: z.string(),
    newText: z.string(),
})

// define a tool set
export const TOOLS: Responses.Tool[] = [
    zodResponsesFunction({
    name: "bash",
    description: "run bash commands",
    parameters: BashSchema
    }),
    zodResponsesFunction({
        name: "read_file",
        description: "read a file content",
        parameters: ReadFileSchema
    }),
    zodResponsesFunction({
        name: "write_file",
        description: "write content to a file",
        parameters: WriteFileSchema
    }),
    zodResponsesFunction({
        name: "edit_file",
        description: "replace text in file",
        parameters: EditFileSchema
    }),
];

// map tool to function and dispatch correspondingly
export type ToolFn = (...arg: any) => string | Promise<string>; 
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
    const output = await run(
        "bash", ["-c", commands],
        {timeout: 30_000, maxBuffer: 10*1024*1024},
    );
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
        await writeFile(filePath, content);
    } catch (err) {
        return String(err);
    }
    return "write file successfully";
}

async function runEditFile(args: unknown): Promise<string> {
    const res = EditFileSchema.safeParse(args);
    if (!res.success) {
        return `edit_file parameters verfication fail: ${z.prettifyError(res.error)}`;
    }
    let filePath = res.data.filePath;
    let oldText = res.data.oldText;
    let newText = res.data.newText;
    try {
        const text = await readFile(filePath, 'utf8');
        await writeFile(filePath, text.replace(oldText, newText));
    } catch (err) {
        return String(err);
    }
    return "replace file successfully";
}

