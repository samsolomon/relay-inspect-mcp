# Relay Inspect

Stop pasting console logs and screenshots into your CLI. Relay Inspect gives Claude Code direct access to your browser — so it can see what you see, verify its own changes, and debug without asking you to copy-paste.

It connects to Chrome DevTools Protocol and exposes browser state as MCP tools: console output, network requests, DOM queries, screenshots, and JavaScript evaluation. Claude edits your code, the dev server reloads, and Claude checks the result itself.

```
Claude Code  ←→  Relay Inspect (MCP over stdio)  ←→  Chrome (CDP over WebSocket)
```

## Setup

### Prerequisites

- Node.js
- Chrome (or any Chromium-based browser)

### Install

```bash
git clone https://github.com/samsolomon/relay-inspect-mcp.git
cd relay-inspect-mcp
npm install
npm run build
```

### Launch Chrome with remote debugging

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

**Linux:**
```bash
google-chrome --remote-debugging-port=9222
```

If Chrome is already running, you'll need to quit it first — the debugging port must be set at launch.

### Register as an MCP server

Add to your Claude Code MCP config (`.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "relay-inspect": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/relay-inspect"
    }
  }
}
```

## Tools

### Browser Inspection

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `evaluate_js` | Execute a JavaScript expression in the browser and return the result | `expression` (string) |
| `get_console_logs` | Return buffered console output (logs, warnings, errors) | `clear` (bool, default: true) |
| `get_network_requests` | Return captured network requests and responses | `filter` (URL substring), `clear` (bool, default: true) |
| `get_network_request_detail` | Get full request/response body for a specific network request | `requestId` (string, from `get_network_requests`) |
| `get_elements` | Query the DOM with a CSS selector and return matching elements' outer HTML | `selector` (string), `limit` (number, default: 10) |
| `take_screenshot` | Capture a screenshot of the current page | `format` (png/jpeg, default: png), `quality` (0-100, jpeg only) |

### Page Control

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `reload_page` | Reload the current page (optionally bypass cache) | `ignoreCache` (bool, default: false) |
| `wait_and_check` | Wait N seconds then return new console output captured during the wait | `seconds` (number, default: 2) |

### Server Management

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `start_server` | Start a dev server or background process and capture its output | `id` (string), `command` (string), `args` (string[]), `cwd` (string), `env` (object) |
| `get_server_logs` | Read stdout/stderr output from a managed server process | `id` (string), `clear` (bool, default: true) |
| `stop_server` | Stop a running managed server process | `id` (string) |
| `list_servers` | List all managed server processes and their status | — |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CHROME_DEBUG_PORT` | `9222` | Chrome debugging port |
| `CHROME_DEBUG_HOST` | `localhost` | Chrome debugging host |
| `CONSOLE_BUFFER_SIZE` | `500` | Max console entries to buffer |
| `NETWORK_BUFFER_SIZE` | `200` | Max network requests to buffer |
| `SERVER_LOG_BUFFER_SIZE` | `1000` | Max log entries per managed server |

## Development

```bash
npm run dev    # Run with tsx (auto-recompile)
npm run build  # Build with tsup
npm start      # Run the built bundle
```

See [CLAUDE.md](./CLAUDE.md) for architecture details and full project conventions.
