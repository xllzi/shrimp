import { runCli } from "./adapter/cli.ts";
import { createJsonlTraceSink } from "./adapter/trace.ts";
import { onModelResponse } from "./app/hooks.ts";
import { countTokenUsage } from "./app/usage.ts";

onModelResponse(countTokenUsage);
const traceSink = process.env.SHRIMP_TRACE === "1" ? createJsonlTraceSink(".artifacts/traces") : undefined;
void runCli(traceSink);
