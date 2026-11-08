import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import z from "zod";
import type { State, ToolCall } from "../domain/agent.ts";
import { BashSchema, EditFileSchema, ReadFileSchema, WriteFileSchema } from "../domain/tools.ts";

export type ToolFn = (args: unknown, state: State, signal?: AbortSignal) => string | Promise<string>;
// The agent uses the tool name to select a function from this table.
export const TOOL_HANDLERS: Record<string, ToolFn> = {
    bash: runBash,
    read_file: runReadFile,
    write_file: runWriteFile,
    edit_file: runEditFile,
};


export async function runTool(call: ToolCall, state: State, signal?: AbortSignal): Promise<string> {
    let output: string;
    // dispatch function and executed
    let fn = TOOL_HANDLERS[call.name];
    try {
        signal?.throwIfAborted();
        output = await fn(call.arguments, state, signal);
    } catch (error) {
        signal?.throwIfAborted();
        output = String(error);
    }
    return output;
}

export async function runBash(args: unknown, state: State, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const res = BashSchema.safeParse(args);
    if (!res.success) {
        return `bash parameters verification fail: ${z.prettifyError(res.error)}`;
    }
    let commands = res.data.commands;
    const child = spawn("bash", ["-c", commands], { detached: process.platform !== "win32" });
    child.stdin.end();
    const kill = () => {
        // Stop the process group so pipelines and child commands stop too.
        if (process.platform !== "win32" && child.pid) {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
        } else {
            child.kill("SIGKILL");
        }
    };
    let failure: Error | undefined;
    // Limit the process to 30 seconds and each output buffer to 10 MiB.
    const timeout = setTimeout(() => {
        failure = new Error("Bash command timed out after 30 seconds.");
        kill();
    }, 30_000);
    const pending = new Promise<string>((resolve, reject) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const collect = (stream: "stdout" | "stderr", chunks: Buffer[]) => {
            let size = 0;
            child[stream].on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 10*1024*1024) {
                    failure ??= new Error(`Bash ${stream} exceeded 10 MiB.`);
                    kill();
                } else {
                    chunks.push(chunk);
                }
            });
        };
        collect("stdout", stdout);
        collect("stderr", stderr);
        child.once("error", reject);
        // Wait for the process and its output streams to close after cancellation.
        child.once("close", (code, exitSignal) => {
            if (signal?.aborted) reject(signal.reason);
            else if (failure) reject(failure);
            else if (code !== 0) reject(new Error(`Bash command failed (${exitSignal ?? code}): ${Buffer.concat(stderr).toString()}`));
            else resolve(Buffer.concat(stdout).toString());
        });
    });
    signal?.addEventListener("abort", kill, { once: true });
    try {
        return await pending;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", kill);
    }
}

export async function runReadFile(args: unknown, state: State, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const res = ReadFileSchema.safeParse(args);
    if (!res.success) {
        return `read_file parameters verification fail: ${z.prettifyError(res.error)}`;
    }
    let filePath = res.data.filePath;
    let content;
    try {
        content = await readFile(filePath, { encoding: 'utf8', signal });
        signal?.throwIfAborted();
    } catch (err) {
        signal?.throwIfAborted();
        return String(err);
    }
    let hash = createHash("sha256").update(content, "utf8").digest("hex");
    state.readFileHashes.set(filePath, hash);
    return content;
}

export async function runWriteFile(args: unknown, state: State, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const res = WriteFileSchema.safeParse(args);
    if (!res.success) {
        return `write_file parameter verification fail: ${z.prettifyError(res.error)}`;
    }
    let filePath = res.data.filePath;
    let content = res.data.content;
    try {
        // Create the file or replace all its content.
        await writeFile(filePath, content, { signal });
    } catch (err) {
        signal?.throwIfAborted();
        return String(err);
    }
    let hash = createHash("sha256").update(content, "utf8").digest("hex");
    state.readFileHashes.set(filePath, hash);
    return "write file successfully";
}

export async function runEditFile(args: unknown, state: State, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const res = EditFileSchema.safeParse(args);
    if (!res.success) {
        return `Error: Invalid \`edit_file\` arguments: ${z.prettifyError(res.error)}`;
    }
    let filePath = res.data.filePath;
    let oldText = res.data.oldText;
    let newText = res.data.newText;
    try {
        if (!state.readFileHashes.has(filePath)) {
            return "Error: File has not been read yet. You need to read the file first before edit the file";
        }
        const text = await readFile(filePath, { encoding: 'utf8', signal });
        signal?.throwIfAborted();
        let hash = createHash("sha256").update(text, "utf-8").digest("hex");
        if (state.readFileHashes.get(filePath) != hash) {
            return "Error: file content changed. You need to read the file first before edit the file";
        }
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
        await writeFile(filePath, updatedText, { signal });
        hash = createHash("sha256").update(updatedText, "utf8").digest("hex");
        state.readFileHashes.set(filePath, hash);
        return "replace text successfully";
    } catch (err) {
        signal?.throwIfAborted();
        return String(err);
    }
}
