import readline from "node:readline/promises";

let input: readline.Interface | undefined;

// Share one reader so permission prompts do not pause the main prompt's input.
export function getReadInterface(): readline.Interface {
    return input ??= readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}
