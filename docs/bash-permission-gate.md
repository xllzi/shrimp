# Tool permissions and Bash rules

## Purpose

Shrimp checks permission before it runs a tool. The rules return `allow`, `ask`, or `deny`. The approval flow converts `ask` to the user's `allow` or `deny` decision.

The agent runs a tool only after an `allow` decision, while the turn is active. The tool handler then checks its arguments. See [Tool execution](tool-execution.md) for the full sequence.

## Responsibilities

| Layer | Source | Responsibility |
| --- | --- | --- |
| Domain | [src/domain/permission.ts](../src/domain/permission.ts) | Defines the rules and returns a verdict. |
| Application | [src/app/permission.ts](../src/app/permission.ts) | Requests approval for `ask` and checks cancellation. |
| Adapter | [src/adapter/bash.ts](../src/adapter/bash.ts) | Parses Bash commands and extracts facts from the syntax tree. |
| Adapter | [src/adapter/cli.ts](../src/adapter/cli.ts) | Supplies the workspace, parser, and terminal approval callback. |

The domain rules use the supplied data. They do not prompt the user or read the process working directory.

`parseBash` uses tree-sitter and the Bash grammar. The packages `web-tree-sitter` and `tree-sitter-bash` supply the WebAssembly files. The adapter returns plain command, pipeline, and redirect facts in a `BashSyntax` value. It does not decide permission.

`runCli` calls `createPermissionCheck({ workspace, parseBash, askPermission })`. It uses `process.cwd()` as the workspace and passes the permission check to `agentLoop`. The approval callback and the main prompt use the same input reader.

## Verdicts and decisions

| Rule verdict | Rank | Effect |
| --- | --- | --- |
| `allow` | 0 | The approval flow returns `allow` without a prompt. |
| `ask` | 1 | The approval flow requests a user decision. |
| `deny` | 2 | The approval flow returns `deny` without a prompt. |

`evaluatePermission` checks the rules for the tool name. It returns the highest-ranked verdict. If ranks are equal, it keeps the first finding. If no rule produces a finding, it returns `allow`.

For Bash, `bashVerdict` checks all extracted facts. It selects the highest rank and combines the finding messages. Thus, a `deny` finding takes priority over an `ask` finding. If Bash has no finding, `bashVerdict` returns `null`.

An `allow` verdict means that the current rules did not block the call. It does not prove that the call is safe.

## Approval and cancellation

The application parses the command only for a `bash` call. It then calls `evaluatePermission` with the tool call, workspace, and any Bash facts.

For an `ask` verdict, the terminal adapter shows the tool name and arguments. It displays this prompt:

```text
Approve this tool call? [y/n]
```

To approve the call, enter `y`. To reject the call, enter `n`. For any other answer, the adapter displays `input y or n` and repeats the prompt.

The application returns the decision with the rule message. It appends `user allow` or `user deny` on a new line. The terminal adapter does not evaluate the rules.

The application checks the `AbortSignal` before it evaluates permission and before and after it requests approval. The terminal adapter also passes the signal to its input reader.

If the user presses `Ctrl+C` during approval, the agent cancels the turn. It does not run the tool. An approval error propagates to the caller instead of granting permission.

## File rules

The file rule applies to `write_file` and `edit_file`. It resolves `filePath` against the supplied workspace, then checks the resulting path.

| Path result | Verdict |
| --- | --- |
| Inside the workspace, or equal to it | `allow` |
| Outside the workspace | `ask` |

For a workspace of `/project`, `src/a.ts` resolves to `/project/src/a.ts` and is inside the workspace. The path `../outside/a.ts` is outside it. The path `/project-other/a.ts` is also outside it.

This rule compares paths without resolving symbolic links. It does not check file access through Bash commands. `read_file` has no permission rule.

## Bash rules

### Deny

A Bash finding has the `deny` verdict when one of these conditions applies:

- The command name is `sudo`, `su`, or `doas`.
- The command name is `shutdown`, `reboot`, `halt`, or `poweroff`.
- The command is `systemctl` with one of those four names as an argument.
- The command name starts with `mkfs`.
- The command name is `fdisk`, `sfdisk`, `cfdisk`, `parted`, `wipefs`, or `blockdev`.
- The command is `dd` with an `of=/dev/<name>` argument that does not refer to a safe device.
- The command is `rm` with a recursive flag and a system root target.
- A redirect destination starts with `/dev/` and is not a safe device.

The safe devices are `/dev/null`, `/dev/stdout`, `/dev/stderr`, and `/dev/tty`.

### Ask

A Bash finding has the `ask` verdict when one of these conditions applies:

- The command is `rm` with a recursive flag and no system root target. Example: `rm -rf build`.
- A pipeline contains `curl` or `wget`, followed by a shell interpreter.
- The command is `eval`.
- The command is a shell interpreter with a `-c` flag.
- The parser returns no syntax tree.
- The syntax tree has a parse error (`rootNode.hasError` is true).

The shell interpreters are `sh`, `bash`, `zsh`, `dash`, `ash`, and `ksh`. The gate cannot inspect the command string supplied to `eval` or `bash -c`.

### No finding

Commands with no finding receive `allow` from `evaluatePermission`. Examples are `ls -la`, `echo hi > /dev/null`, and `rm file.txt`.

## Bash matching

The parser removes matching outer quotes from argument words and redirect destinations. For example, `"$HOME"` becomes `$HOME`. It does not expand variables.

The rules use `/^-{1,2}[^-]/` to identify flags. Other words are arguments.

For `rm`, a short flag group that contains `r` or `R` is recursive. The long flag `--recursive` also matches. Thus, `-rf`, `-fr`, and `-r -f` all match.

The system root targets are `/`, `/*`, `~`, `~/*`, `$HOME`, `$HOME/*`, `${HOME}`, and `${HOME}/*`. The rule removes trailing slashes before it compares the target.

The parser skips `variable_assignment` nodes when it collects command arguments. Thus, `FOO=1 rm -rf /` still matches the `rm` rule.

## Wrapper commands

The wrapper commands are `env`, `nohup`, `nice`, `stdbuf`, `xargs`, and `command`. Their arguments can contain another command.

The rules first check the wrapper itself. If it produces no finding, they remove `NAME=value` words. They select the first remaining word that is not a flag as the inner command name.

The rules check that name with the words that follow it. For example, `env FOO=1 mkfs.ext4 /dev/sdb` matches the `mkfs` rule. This check does not recursively examine further wrapper commands.

## Tree coverage and limits

The parser visits all named nodes in the syntax tree. This includes commands in loops, subshells, command substitutions, and pipelines. For example, `echo $(sudo reboot)` returns `deny`.

The gate does not track data flow. Its limits include:

- Command strings supplied to `bash -c` or `eval`. These calls produce an `ask` finding.
- Data that a pipeline decodes or expands at run time. The gate does not decode that data.
- Commands such as `find -exec` that use their arguments to run another command. The gate sees the words but does not inspect that execution.

## Tests

- [Domain tests](../src/domain/permission.test.ts) check verdict priority, missing syntax, and workspace paths.
- [Application tests](../src/app/permission.test.ts) check approval decisions, cancellation, and approval errors.
- [Parser tests](../src/adapter/bash.test.ts) check Bash rules with command strings and nested syntax.
- [CLI tests](../src/main.test.ts) check cancellation during requests, tool execution, and approval.
