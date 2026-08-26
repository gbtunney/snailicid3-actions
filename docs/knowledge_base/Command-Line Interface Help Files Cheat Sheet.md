# Command-Line Interface (CLI) Help Files & Syntax Cheat Sheet

A comprehensive reference guide for reading, understanding, and writing CLI help files, manual pages, and parser documentation.

---

## Bracket & Symbol Mechanics

| Symbol | Name | Meaning / Rule | Example |
| :--- | :--- | :--- | :--- |
| `< >` | **Angle Brackets** | **Required** argument. You must supply your own value. | `git clone <url>` |
| `[ ]` | **Square Brackets** | **Optional** argument, flag, or section. Can be omitted. | `git status [path]` |
| `{ }` | **Curly Braces** | A finite list of specific choices. You **must** pick exactly one. | `--format {json\|text\|xml}` |
| `\|` | **Vertical Bar (Pipe)** | **OR** separator. Exclusive choice between items. | `[yes\|no]` or `--mode <dev\|prod>` |
| `...` | **Ellipsis** | **Variadic loop**. The argument or option can be repeated multiple times. | `rm <file>...` |

### Combined Syntax Examples
* `[<file>...]`: Zero, one, or multiple **optional** files.
* `<file>...`: One or more **required** files.
* `[--format {json\|text}]`: An optional flag where, if used, you must choose either `json` or `text`.

---

## Flag Evolution & Handling

* **Short Flags (`-`)**: Prefixes a single-letter shortcut flag (e.g., `-h`).
* **Long Flags (`--`)**: Prefixes a full-word descriptor flag (e.g., `--help`).
* **Flag Chaining / Clustering**: Multiple short flags can often be stacked together behind a single dash if only the final flag requires a value (e.g., `-xzvf` instead of `-x -z -v -f`).
* **End of Options Delimiter (`--`)**: Indicates the termination of options/flags. Everything following a standalone `--` is strictly treated as a positional argument. This allows you to safely pass filenames that begin with a dash without the parser confusing them for command options.
  * *Example:* `rm -- -filename-with-dash`

---

## Usage vs. Example

| Feature | Usage | Example |
| :--- | :--- | :--- |
| **Definition** | The abstract blueprint (The Rulebook). | A concrete, real-world manifestation (The Application). |
| **Purpose** | Defines syntax layout, parameters, and constraints. | Demonstrates a practical solution to a specific problem. |
| **Brackets?** | **Yes** (Uses `< >`, `[ ]`, `{ }` to define parsing logic). | **No** (All structural syntax brackets are stripped away). |
| **Placeholders?**| **Yes** (Uses placeholder strings like `<path>`). | **No** (Uses real data values like `./images/pic.jpg`). |
| **Execution** | **Cannot** be copy-pasted directly into terminal (fails). | **Can** be copy-pasted and run right out of the box. |

---

## Typographic & Structural Standards

* **`bold` text**: Enter this text **exactly as written**. This is typically reserved for commands, subcommands, and flags (e.g., `git checkout`).
* *`italic`* or `_underlined_` text: Replace this with your own specific runtime value. These are variables or placeholders (e.g., *`repository_url`*).
* **Fixed Order**: Positional arguments must be typed in the exact sequence shown in the usage block.
* **Whitespace**: Single spaces separate commands, flags, and arguments.
* **Case Sensitivity**: Flags are case-sensitive. `-v` (often verbose) and `-V` (often version) represent entirely different configurations.

---


## Sample Help Block

Below is a full, standard implementation of a modern CLI help screen demonstrating how all these concepts coalesce into a unified interface.

```sh
docker-app-manager v2.4.1 - Manage cloud application deployments

USAGE:
    app-deploy <command> [options]
    app-deploy run --image <id> [--port <port>] <env-file>...
    app-deploy rollback <app-id> [--version <semver>]

COMMANDS:
    run              Provision and spin up a new container instance.
    rollback         Revert a target application to a historic version state.
    status           Display health, container uptimes, and event logs.

OPTIONS:
    -i, --image <id>            Target base container image ID (required).
    -p, --port <port>           Network port binding to expose [default: 8080].
    --no-telemetry              Disable background telemetry metrics reporting.
    --db.host <string>          Set deep nested configuration for database host address.
    --db.timeout <ms>           Set nested database connection timeout threshold [default: 5000].
    -v, --verbose               Increase logging intensity. Stackable flag (e.g., -vvv).
    -h, --help                  Print out this command overview layout screen.
    --                          Treat all following arguments as literals. Useful for
                                files starting with a dash marker.

EXAMPLES:
    1. Deploy an instance using explicit images and ports over multiple configuration environments:
       $ app-deploy run --image ubuntu-node:18 -p 3000 production.env staging.env

    2. Revert an internal service back to a specific target version using semantic flags:
       $ app-deploy rollback srv-9482 --version 1.4.2

    3. Initialize a container with deep structural database settings and silenced analytics:
       $ app-deploy run --image redis:latest --no-telemetry --db.host 10.0.0.5 --db.timeout 2500 active.env
```

---
## Modern Parser Specialties (Commander.js & Yargs)

* **Boolean Inversion (`--no-` prefix)**: Used to explicitly turn off a default behavior. If a program defaults to caching files, adding a `--no-cache` flag programmatically flips an internal boolean variable (e.g., `cache`) to `false`.
* **Option Aliasing**: Grouping short and long versions together in the descriptive text.
  * *Example:* `-d, --dir <path>`
* **Dot Notation**: Heavily utilized in frameworks like Yargs to build complex, nested configuration objects directly from flattened terminal strings.
  * *Example:* `--user.name "Alice" --user.role "Admin"` maps natively into `{ user: { name: "Alice", role: "Admin" } }`.
* **Variadic Options**: Specifying that an option flag can ingest a space-separated stream of multiple values.
  * *Example:* `--ids 101 102 103` parsed via a template like `--id <number...>` or passing the flag repeatedly (`-v -v -v` to scale log verbosity).
* **`$0` Variable**: A runtime template placeholder variable used within framework string builders to output the base execution command name automatically.

---