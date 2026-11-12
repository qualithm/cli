# CLI

<!-- Uncomment after the first release -->
<!--
[![CI](https://github.com/qualithm/cli/actions/workflows/ci.yaml/badge.svg)](https://github.com/qualithm/cli/actions/workflows/ci.yaml)
[![codecov](https://codecov.io/gh/qualithm/cli/graph/badge.svg)](https://codecov.io/gh/qualithm/cli)
[![npm](https://img.shields.io/npm/v/@qualithm/cli)](https://www.npmjs.com/package/@qualithm/cli)
-->

CLI and MCP server for managing devices and teams on Qualithm. The `qualithm` command runs each
operation in a terminal, and `qualithm mcp` serves the same operations to an agent.

## Features

- One tool set for people and agents: every command runs the same operation as its MCP tool.
- `--json` prints one envelope line, `{ok, code?, message?, dryRun?, action?, data?}`, with stable
  codes and exit codes.
- `--dry-run` on every change reports the request it would send, without sending it.
- `qualithm mcp` serves every tool over stdio; `qualithm agents connect` adds it to Claude and
  Codex.

## Installation

```bash
npm install --global @qualithm/cli
```

## Quick Start

Create an API token in the app, on your team page, then:

```bash
export QUALITHM_API_TOKEN=<your-api-token>
qualithm token list
```

## Usage

### Commands

```bash
qualithm token list --json
qualithm token revoke <token-id> --dry-run
qualithm --help
```

Every verb takes `--url`, `--token`, `--team`, `--json` and `--dry-run`, before or after its
arguments. `--team` defaults to the token's own team.

### Run a project as a virtual device

A virtual device runs a MicroPython project on this computer, with no board. It claims, connects and
reports as a board does, and counts as a device on your plan. It runs on macOS and Linux; on
Windows, use WSL.

In a project folder whose `main.py` calls `board.start()` from the Qualithm Device SDK:

```bash
qualithm deploy --virtual
```

The first deploy downloads MicroPython and the SDK, claims the device into your team's scope, and
starts it. The device is named after the folder, for example `virtual:my-sensor`. A later deploy
copies only what changed and restarts it, without claiming again. Follow its output, or restart it:

```bash
qualithm board logs --serial virtual:my-sensor -f
```

```bash
qualithm board reset --serial virtual:my-sensor
```

An agent does the same through the `deploy_project` tool with `virtual: true`.

### Connect your agent

```bash
qualithm agents connect
```

This registers `qualithm mcp` with every agent installed on this computer: Claude desktop, Claude
Code, the Codex app and the Codex CLI. Each gets one MCP server named `qualithm` that starts this
`qualithm` by its absolute path. No token is written to any config. Running it again changes
nothing; an entry that starts a different `qualithm` is updated. Restart a running agent to load it.

```bash
qualithm agents connect --dry-run    # show the config changes without making them
qualithm agents disconnect           # remove qualithm from every agent
```

With `--json`, `data` holds the server entry and one report per agent, whose `status` is
`not_installed`, `already_connected`, `connected`, `not_connected`, `removed` or `failed`
(`would_connect` or `would_remove` on a dry run), with the `before` and `after` entries. A failed
agent never stops the others; the envelope then has `ok: false` and still carries every report. An
agent does the same through the `connect_agents` and `disconnect_agents` tools.

Every tool that changes something takes `dryRun`.

### Error Handling

Branch on the exit code or the envelope's `code`, never on the message:

| Exit | `code`         | Meaning                                 |
| ---- | -------------- | --------------------------------------- |
| 0    |                | success, including a dry run            |
| 1    | `error`        | the request failed to send              |
| 2    | `usage`        | a bad flag or argument, or no token     |
| 3    | `auth`         | the token was refused                   |
| 4    | `not_found`    | no such resource                        |
| 5    | `conflict`     | the change conflicts with current state |
| 6    | `rate_limited` | too many requests; wait and retry       |
| 7    | `api`          | any other API error                     |
| 8    | `unavailable`  | the API is briefly unavailable; retry   |

## API Reference

The package also exports `run` and `buildMcpServer`, for embedding the CLI. Generate the reference
with [TypeDoc](https://typedoc.org/):

```bash
bun run docs
```

## Examples

```bash
qualithm token revoke tok_123 --dry-run --json
```

```json
{
  "ok": true,
  "dryRun": true,
  "action": { "method": "DELETE", "path": "/v1/teams/team_123/api-tokens/tok_123" }
}
```

## Development

### Prerequisites

- [Bun](https://bun.sh/)

### Setup

```bash
bun install
```

### Building

```bash
bun run build
```

### Testing

```bash
bun run test
bun run test:coverage:unit
```

### Linting & Formatting

```bash
bun run lint
bun run format
bun run typecheck
```

## License

Apache-2.0
