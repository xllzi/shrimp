# Tool execution

Shrimp gives the model four tools. The model requests a tool call. The agent runtime runs the tool and returns its result to the model.

| Tool | String arguments | Result on success |
| --- | --- | --- |
| `bash` | `commands` | Standard output |
| `read_file` | `filePath` | File content as UTF-8 text |
| `write_file` | `filePath`, `content` | `write file successfully` |
| `edit_file` | `filePath`, `oldText`, `newText` | `replace text successfully` |

## From tool call to result

1. The model adapter parses the arguments and checks that they form a JSON object. If this check fails, the agent records the error as the result without running hooks or permission checks.
2. The agent processes calls in the order in which they appear in the model response. If the arguments form a JSON object, it runs the `PreToolUse` hook and checks permission on the resulting call.
3. If the permission check returns `allow`, `runTool` selects the handler from `TOOL_HANDLERS`. Each handler validates its arguments. If validation fails, the handler returns an error. If the permission check returns `deny`, the agent uses the denial message as the result.
4. If the turn is active, the `PostToolUse` hook can change the result. The agent records the result with the tool call ID. The next model request includes the results in its message history.

The [Bash permission gate](bash-permission-gate.md) checks `bash` commands. The file permission rule checks `write_file` and `edit_file` paths against the current working directory. It can ask for approval. It compares path strings, so a relative path can also trigger the prompt. `read_file` has no permission rule.

## Bash execution

`runBash` calls `spawn` to start `bash -c` with `commands`. The handler closes the child's standard input and collects standard output and standard error separately.

```text
Node.js process (agent runtime, runBash, AbortController)
└── Bash child process
    └── Command processes that Bash starts, if any
```

When Bash exits with code 0 and the streams close, the handler returns standard output. If Bash fails, the error includes the exit code or signal and the collected standard error. A 30-second timer stops the command if it takes too long. The handler also stops it if either output stream exceeds 10 MiB.

On Linux, `detached: true` gives Bash its own process group. The Node.js process calls `process.kill(-child.pid, "SIGKILL")` to stop the group. This reaches pipeline processes that still belong to that group. On Windows, the handler calls `child.kill("SIGKILL")` on the Bash process.

## File operations

The file handlers call the Node.js file API in the agent runtime. They use `filePath` as the key in `state.readFileHashes`, a map that the CLI keeps across turns.

### Read and write

`read_file` reads the full file as UTF-8 text. It saves a SHA-256 hash of the text and returns the text.

`write_file` creates a file or replaces its full content with `content`. After a successful write, it saves a SHA-256 hash of `content`.

### Edit

`edit_file` changes one exact occurrence of `oldText` to `newText`.

1. The handler checks for a saved hash under the same `filePath`. A successful `read_file`, `write_file`, or earlier `edit_file` call supplies this hash.
2. The handler reads the current text and compares its hash with the saved hash. If the hashes differ, the handler returns an error. A new `read_file` call supplies a hash for the current text.
3. The handler requires a nonempty `oldText` that occurs exactly once. It counts overlapping matches too. If there is no match, read the file again. If there are multiple matches, add surrounding text to `oldText`.
4. The handler inserts `newText` as literal text and writes the full file. An empty `newText` deletes the match.
5. After the write succeeds, the handler saves the SHA-256 hash of the new text under the same `filePath`.

The next edit can use the new hash without another `read_file` call if the content still matches. The hash check compares the text at the time of the read. An external process can still change the file between this check and the write.

## Cancellation

The CLI creates one `AbortController` per turn. When the user presses `Ctrl+C` during a turn, the CLI calls `controller.abort()`. The `AbortSignal` emits an `abort` event inside Node.js. The Bash handler listens for that event and sends the operating system signal described above. It waits for the Bash process and its output streams to close before it reports cancellation.

The file handlers pass the `AbortSignal` to the file API. Cancellation can interrupt a write after it has changed the file.

The agent records a cancellation result for the interrupted call. It also records a result for each remaining call without starting that call or sending another model request.

Source files are [agent.ts](../src/agent.ts), [tools.ts](../src/tools.ts), [permission.ts](../src/permission.ts), and [main.ts](../src/main.ts).
