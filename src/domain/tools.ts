import { z } from "zod";

// These schemas define the tool parameters and check arguments before execution.
export const BashSchema = z.object({
    commands: z.string(),
})

export const ReadFileSchema = z.object({
    filePath: z.string(),
})

export const WriteFileSchema = z.object({
    filePath: z.string(),
    content: z.string(),
})

export const EditFileSchema = z.object({
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

