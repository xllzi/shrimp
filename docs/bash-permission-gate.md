# Specification: Bash Permission Gate

## 1. Purpose

The agent runs shell commands through the `bash` tool. The gate inspects each command before the tool runs it.

The gate returns one verdict: `allow`, `ask`, or `deny`. The tool runs the command only for `allow`. For `ask`, the user approves or rejects the call in the terminal. For `deny`, the tool never runs the command.

## 2. Design

The gate parses the command string with tree-sitter and the bash grammar. Both ship as wasm files in the packages `web-tree-sitter` and `tree-sitter-bash`.

The parser produces a syntax tree. The gate walks the full tree and applies rules to three node types: `command`, `pipeline`, and `file_redirect`.

## 3. Verdicts

| Verdict | Rank | Meaning |
|---|---|---|
| `allow` | 0 | No finding. The tool runs the command. |
| `ask` | 1 | Risky or opaque. The user decides. |
| `deny` | 2 | Dangerous. The tool never runs the command. |

One command can produce several findings. The gate returns the finding with the highest rank.

## 4. Rules

### 4.1 Deny

- The command name is `sudo`, `su`, or `doas`.
- The command name is `shutdown`, `reboot`, `halt`, or `poweroff`. `systemctl` with one of these words as an argument matches too.
- The command name starts with `mkfs`, or is `fdisk`, `sfdisk`, `cfdisk`, `parted`, `wipefs`, or `blockdev`.
- `dd` has an argument `of=/dev/<name>`, and `<name>` is not a safe device.
- `rm` has a recursive flag, and one target is a system root (see section 5).
- A redirect destination starts with `/dev/` and is not a safe device.

The safe devices are `/dev/null`, `/dev/stdout`, `/dev/stderr`, and `/dev/tty`.

### 4.2 Ask

- `rm` has a recursive flag and no system root target. Example: `rm -rf build`.
- A pipeline sends the output of `curl` or `wget` into a shell interpreter. The interpreters are `sh`, `bash`, `zsh`, `dash`, `ash`, and `ksh`.
- The command is `eval`, or a shell interpreter with a `-c` flag. The parser cannot inspect the string.
- The tree has a parse error (`rootNode.hasError` is true).

### 4.3 Allow

Every command with no finding. Examples: `ls -la`, `echo hi > /dev/null`, `rm file.txt`.

## 5. Matching rules

The gate strips quotes before it matches. `"$HOME"` becomes `$HOME`.

A word that starts with one or two hyphens is a flag. The other words are arguments.

For `rm`, the recursive test does two checks. It scans each short flag cluster for the letter `r` or `R`. It also accepts the long flag `--recursive`. So `-rf`, `-fr`, and `-r -f` all match.

The system root set is `/`, `/*`, `~`, `~/*`, `$HOME`, `$HOME/*`, `${HOME}`, and `${HOME}/*`. The gate ignores trailing slashes.

The gate skips `variable_assignment` nodes. `FOO=1 rm -rf /` matches the `rm` rule.

## 6. Wrapper commands

The wrappers are `env`, `nohup`, `nice`, `stdbuf`, `xargs`, and `command`. A wrapper can hide the real command in its arguments.

For a wrapper, the gate drops `NAME=value` words and flags. It takes the first remaining word as the command name and re-runs the rules. Example: `env FOO=1 mkfs.ext4 /dev/sdb` matches the `mkfs` rule.

## 7. Tree coverage

The walk visits every node in the tree. Loops, subshells, command substitutions, and pipelines contain `command` nodes. The rules apply to each node. Example: `echo $(sudo reboot)` returns `deny`.

## 8. Limitations

The gate does not track data flow. It has these blind spots:

- The content of a string after `bash -c` or `eval`. The gate returns `ask` for these commands.
- Data that a pipeline decodes or expands at run time. The gate does not decode data.
- Commands that build a command from their arguments, such as `find -exec`. The gate sees only the words.

