# Relay Inspect

An MCP server that gives Claude Code real-time visibility into your browser — console logs, network requests, DOM elements, and JavaScript evaluation — via Chrome DevTools Protocol.

```
Claude Code  ←→  Relay Inspect (MCP over stdio)  ←→  Chrome (CDP over WebSocket)
```

Relay Inspect connects to a running Chrome instance and continuously buffers console and network events. Claude Code calls the MCP tools to read those buffers, query the DOM, or execute JavaScript — enabling a tight feedback loop where Claude can edit code, wait for the dev server to reload, and immediately verify the result by inspecting the browser.

## Setup

### Prerequisites

- Node.js
- Chrome (or any Chromium-based browser)

### Install

```bash
git clone https://github.com/anthropics/relay-inspect.git
cd relay-inspect
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

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `evaluate_js` | Execute a JavaScript expression in the browser and return the result | `expression` (string) |
| `get_console_logs` | Return buffered console output (logs, warnings, errors) | `clear` (bool, default: true) |
| `get_network_requests` | Return captured network requests and responses | `filter` (URL substring), `clear` (bool, default: true) |
| `get_elements` | Query the DOM with a CSS selector and return matching elements' outer HTML | `selector` (string), `limit` (number, default: 10) |
| `wait_and_check` | Wait N seconds then return new console output captured during the wait | `seconds` (number, default: 2) |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CHROME_DEBUG_PORT` | `9222` | Chrome debugging port |
| `CHROME_DEBUG_HOST` | `localhost` | Chrome debugging host |
| `CONSOLE_BUFFER_SIZE` | `500` | Max console entries to buffer |
| `NETWORK_BUFFER_SIZE` | `200` | Max network requests to buffer |

## Development

```bash
npm run dev    # Run with tsx (auto-recompile)
npm run build  # Build with tsup
npm start      # Run the built bundle
```

See [CLAUDE.md](./CLAUDE.md) for architecture details and full project conventions.
