import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TraceSink } from "../app/trace.ts";

/** If a file operation fails, warn once and skip later writes. The agent continues the session. */
export function createJsonlTraceSink(directory: string): TraceSink {
    let failed = false;
    return event => {
        if (failed) return;
        try {
            if (event.type === "run.started") mkdirSync(directory, { recursive: true, mode: 0o700 });
            appendFileSync(join(directory, `${event.attempt_id}.jsonl`), `${JSON.stringify(event)}\n`, { mode: 0o600 });
        } catch {
            failed = true;
            console.error("Shrimp could not write trace events. Tracing is disabled for this session.");
        }
    };
}
