![Emergence 1.08 · Code / Data / Terminal](docs/media/emergence-1.08-cover.png)

# Emergence · 涌现

**A Chinese-first terminal agent for working with code and data in your project directory.**

Trace a bug from its entry point to a failing test, or turn a local orders table into a report you can reproduce. Choose a model for each pane and follow the tools it uses, the approvals it requests, and the evidence behind the result.

[Release **1.08**](https://github.com/shianlab/emergence/releases/tag/v1.0.8) · Windows x64 · [MIT](LICENSE) · [简体中文](README.md)

[Install](#install)　/　[Workspace](#a-terminal-workspace)　/　[Code and data](#work-with-code-and-data)　/　[Permissions](#stay-in-control)　/　[Updates](#updates-and-maintenance)　/　[Develop](#develop)

## Install

Run in **PowerShell on Windows x64**:

```powershell
irm https://raw.githubusercontent.com/shianlab/emergence/main/install.ps1 | iex
```

The installer verifies the signed release manifest and SHA-256, retries interrupted downloads, reuses verified downloads, and checks startup before activation. The release includes its own runtime and installs under your Windows user account. [Review the script](install.ps1) · [Manual and offline installation](docs/installation.md)

```powershell
cd "D:\my-project"
emergence --version
emergence
```

1. Enter `/model-config` to configure a provider, model, endpoint and API key. Test the connection and save. [Model configuration guide](docs/model-configuration.md)
2. Use `/model` to select it for the current pane. Check the project directory on the home screen.
3. Send a first task such as “Read this project and tell me how to start it and run its tests.” Type `/` to find commands. Use `Shift+Tab` to cycle permission modes, including Rage. Enter `/permission rage` to enable automatic tool approval for the current pane.

Windows 11 and Windows Terminal are recommended for the Windows x64 release. The native configuration tool requires .NET Framework 4.8. Supply your own model API credentials. The optional data analysis tools require CPython 3.14 x64.

## A terminal workspace

![Home screen exported from the actual TUI renderer](docs/media/home.svg)

The frame uses demo configuration and a demo project path.

<details>
<summary>View the command menu</summary>

![Slash command suggestions in the terminal](docs/media/commands.svg)

</details>

| Capability | What it provides |
| --- | --- |
| Coding | Project context, change planning, file edits, checks and execution evidence |
| Data analysis | Profiling, SQL and statistics over CSV/TSV/XLSX/Parquet, with charts and reproducible reports |
| Built-in KIM | Requirement intake, planning, governance roles, evidence and memory within the session runtime |
| Model choice | Configurable OpenAI Completions/Responses, Anthropic Messages and Google Generative AI protocols; gateway compatibility must be verified |
| Independent panes | Separate projects, models, drafts and conversations; user-directed tasks in each pane |
| Extensibility | `EMERGENCE.md`, Skills, MCP and local extensions |
| Execution visibility | Streaming replies, live status, tool details, keyboard approvals, cancellation and history |

Emergence Harness integrates the DeepSeek Harness execution foundation, OpenTUI, Meta_Kim-derived governance and specialized coding/data tools. It is an independent product; upstream attribution remains in [THIRD_PARTY_NOTICES.md](emergence/THIRD_PARTY_NOTICES.md).

## Work with code and data

### Investigate an empty-file import

Start in **Plan** mode to locate the failure. For example, ask:

> Trace an empty file from the file picker through the first row of the parser. Show where the failure happens and which tests cover that path.

After reviewing the plan, switch to **Auto edit** and ask for the change:

> Return “No data to import” for an empty file. Preserve the existing behavior for populated files. Add tests for both cases and run the relevant checks.

Use `/plan` to inspect the acceptance conditions and `/tasks` to see execution progress. Open `/code` to check the working directory, exit code, diagnostics and changed files. Put recurring build commands and editing conventions in `EMERGENCE.md`. Use `/init` to preview it.

### Explain a change in monthly revenue

Install CPython 3.14 x64 and initialize the data environment with the path to your interpreter:

```powershell
emergence data-init --python "C:\Python314\python.exe"
```

> Read orders.csv. Check for duplicate order IDs and missing dates or amounts. Group paid amounts by payment month and channel, account for refunds separately, and show each channel’s contribution to the month-over-month change. Ask about missing fields before calculating.

The native analysis tools work with local CSV, TSV, XLSX and Parquet files. Read the input-quality section before interpreting the totals. Check the CSV breakdown against the report, export the SVG chart, or use the input snapshot and `replay.py` to recompute the result. Artifacts are stored under `core/data-runs/<run ID>/` in the configuration directory.

The native analysis limits are 8 MiB of input, 10,000 rows, 128 columns and 100,000 cells. Computation runs locally. Your model provider may receive conversation context and tool results. [Methods and scope](docs/code-data-phase5-report.md)

## Stay in control

Permissions: `plan` is read-only; `ask` requests approval for effects; `edit` allows ordinary in-project edits; `auto` allows explicitly configured execution scopes. Auto mode respects deny rules and mandatory approval. Rage mode auto-approves tool calls in the current pane, including shell commands, out-of-project file operations and MCP tools. OS permissions and task-level read-only restrictions still apply. These controls are not an OS sandbox. See [SECURITY.md](SECURITY.md).

Use `F2` / `F3` to split, `Tab` to switch and `F6` to close panes. **Panes are independent:** there is no master-pane control or cross-pane delegation. Coordinate simultaneous edits yourself, preferably with separate Git worktrees.

`Enter` sends, `Shift+Enter` inserts a newline. `/help` and `Ctrl+P` discover commands; `/sessions` opens history; `/init` prepares project instructions; `/skills`, `/mcp`, `/context` and `/doctor` inspect capabilities and runtime state. Restoring a session does not replay side effects.

Credentials use Windows DPAPI for the current user. Configuration and history default to `%USERPROFILE%\.emergence`. The CLI/TUI is Chinese-first and supports `/language en`; documentation and translation improvements are welcome.

## Updates and maintenance

Users on **1.00 or 1.01** can migrate with the installer above. Starting with **1.02**, open `/update` to check the stable channel and choose when to install, or run these commands from PowerShell. [Installation and proxy setup](docs/installation.md)

```powershell
emergence update --check
emergence update
emergence rollback
```

New windows use the update after the installer verifies it. Open windows can finish their current tasks. The installer keeps a healthy previous version for rollback. Configuration, keys, and sessions live separately from application versions. Release 1.08 adds an official fallback for update checks and fixes installer maintenance from PowerShell 7. [Release notes](docs/releases/1.0.8.md) · [Changelog](CHANGELOG.md)

## Develop

Use Git, Node **26.13.0**, npm, and the .NET Framework 4.8 compiler on Windows.

```powershell
git clone https://github.com/shianlab/emergence.git
cd emergence\emergence
npm ci
npm run build
npm start
```

Run `npm run check`, `npm test` and relevant integration checks. Data tests require the Python environment. See [CONTRIBUTING.md](CONTRIBUTING.md), [installation and upgrades](docs/installation.md), [release notes](docs/releases/1.0.8.md) and the [application manual](emergence/README.md).

## License and support

Own code is [MIT](LICENSE). Third-party code and derived assets retain their original licenses and notices. See [attributions](emergence/THIRD_PARTY_NOTICES.md).

Report reproducible bugs through [GitHub Issues](https://github.com/shianlab/emergence/issues), without keys or private project data. Follow the [security policy](SECURITY.md) for vulnerabilities. The official 1.08 package targets Windows x64.
