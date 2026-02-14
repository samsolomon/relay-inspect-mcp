# Relay Inspect

An MCP server that bridges AI coding agents and Chrome DevTools Protocol, giving agents real-time visibility into console logs, network requests, DOM elements, and the ability to execute JavaScript in the browser.

## Architecture

```
                                                    ┌─ Chrome (CDP over WebSocket)
AI Coding Agent  ←→  Relay Inspect (MCP over stdio) ─┤
                                                    └─ Dev Servers (child processes)
```

- MCP server built with `@modelcontextprotocol/sdk`, communicates with the AI coding agent over stdio
- Connects to Chrome via `chrome-remote-interface` on `localhost:9222`
- Buffers console and network events continuously once connected
- Stateless tools — each tool call returns current buffer contents or live queries

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript, strict mode
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **CDP Client:** `chrome-remote-interface`
- **Schema validation:** `zod`
- **Build:** `tsup` or `tsc` (keep it simple)

## Project Structure

```
relay-inspect/
├── src/
│   ├── index.ts            # Entry point — MCP server setup, tool registration, exit handlers
│   ├── cdp-client.ts       # Chrome connection, event buffering, reconnection, auto-launch integration
│   ├── chrome-launcher.ts  # Chrome path discovery, auto-launch, CDP readiness polling
│   └── server-manager.ts   # Dev server lifecycle management (start/stop/logs)
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

## MCP Tools

### Browser Inspection

| Tool | Description | Parameters |
|------|-------------|------------|
| `evaluate_js` | Execute a JS expression in the browser and return the result | `expression: string` |
| `get_console_logs` | Return buffered console output since last call | `clear?: boolean` (default true) |
| `get_network_requests` | Return captured network requests and responses | `filter?: string` (URL substring), `clear?: boolean` |
| `get_network_request_detail` | Get full request/response body for a specific request | `requestId: string` |
| `get_elements` | Query DOM and return matching HTML | `selector: string`, `limit?: number` (default 10) |
| `take_screenshot` | Capture a screenshot of the current page | `format?: "png" \| "jpeg"` (default png), `quality?: number` (jpeg only) |

### Page Control

| Tool | Description | Parameters |
|------|-------------|------------|
| `reload_page` | Reload the current page (optionally bypass cache) | `ignoreCache?: boolean` (default false) |
| `wait_and_check` | Wait N seconds then return new console output (for post-reload checks) | `seconds?: number` (default 2) |

### Server Management

| Tool | Description | Parameters |
|------|-------------|------------|
| `start_server` | Start a dev server or background process and capture its output | `id: string`, `command: string`, `args?: string[]`, `cwd?: string`, `env?: Record<string, string>` |
| `get_server_logs` | Read stdout/stderr output from a managed server process | `id: string`, `clear?: boolean` (default true) |
| `stop_server` | Stop a running managed server process | `id: string` |
| `list_servers` | List all managed server processes and their status | _(none)_ |

### Diagnostics

| Tool | Description | Parameters |
|------|-------------|------------|
| `check_connection` | Check Chrome connection status and diagnose issues (no auto-launch) | _(none)_ |

### Nice-to-Have Tools (not yet implemented)

| Tool | Description |
|------|-------------|
| `get_computed_styles` | Get computed CSS for an element |
| `get_page_errors` | Return only errors and warnings from console |
| `watch_console` | Subscribe to console output matching a pattern and return matches (long-poll style) |

## CDP Domains to Enable

- **`Runtime`** — `consoleAPICalled` events for console log capture, `evaluate` for JS execution
- **`Network`** — `requestWillBeSent`, `responseReceived`, `loadingFailed` for network monitoring
- **`DOM`** — `getDocument`, `querySelector`, `querySelectorAll`, `getOuterHTML` for element inspection
- **`Page`** — `reload`, `navigate` if implementing page control
- **`Log`** — `entryAdded` for browser-level errors

## Event Buffering

Console and network events should be buffered in memory with sensible limits:

- **Console buffer:** Last 500 entries, each with timestamp, level (log/warn/error), and message
- **Network buffer:** Last 200 requests, each with URL, method, status, timing, and truncated response body
- Buffers should be drainable — `get_console_logs` clears the buffer by default so the agent sees only new entries
- Include timestamps on everything so the agent can correlate events with code changes

## Connection Management

- **Lazy connect** — Don't connect at startup. On each tool call, `ensureConnected()` checks for an active connection and connects if needed
- **Auto-launch** — If Chrome is not reachable on first tool call and `CHROME_AUTO_LAUNCH` is enabled (default: true), the server will automatically find and launch Chrome with `--remote-debugging-port`. Set `CHROME_PATH` to override Chrome discovery. The auto-launched Chrome is killed on MCP shutdown
- **Orphan cleanup** — On connect, checks for a PID file from a previous MCP session and kills any orphaned Chrome before launching a fresh one
- **Liveness check** — Before reusing an existing connection, verify it's alive with a lightweight `Browser.getVersion()` call. If stale, reconnect
- **Fresh discovery** — Always discover Chrome targets via HTTP (`CDP.List()` hitting `http://host:port/json/list`), never cache WebSocket URLs. This handles Chrome restarts transparently
- **Retry with backoff** — Connection attempts retry 3 times with 500ms initial delay, doubling each attempt
- **Graceful disconnect** — On Chrome disconnect, null out the client and let the next tool call reconnect lazily. No background reconnect timers
- Log connection status to stderr (MCP uses stdout for protocol, stderr for diagnostics)
- Support configurable port via environment variable: `CHROME_DEBUG_PORT=9222`

## Error Handling

- If Chrome isn't connected, tools should return a clear error message, not throw
- If a CSS selector matches nothing, return an empty result with a helpful message
- If JS evaluation throws, capture and return the error message
- Network request bodies that are too large should be truncated with a note

## Configuration

Support these environment variables:

```
CHROME_DEBUG_PORT=9222          # Chrome debugging port (default: 9222)
CHROME_DEBUG_HOST=localhost     # Chrome debugging host (default: localhost)
CHROME_AUTO_LAUNCH=true         # Auto-launch Chrome if not running (default: true)
CHROME_PATH=/path/to/chrome     # Override Chrome executable path (default: auto-detect)
CHROME_LAUNCH_URL=http://...   # URL to open when Chrome is auto-launched (default: none)
CDP_WS_URL=ws://...            # Connect directly to a CDP WebSocket, skip Chrome discovery (default: none)
CONSOLE_BUFFER_SIZE=500         # Max console entries to buffer (default: 500)
NETWORK_BUFFER_SIZE=200         # Max network requests to buffer (default: 200)
SERVER_LOG_BUFFER_SIZE=1000     # Max log entries per managed server (default: 1000)
```

## Testing

### Manual Testing

1. Run the server directly to test (Chrome will auto-launch if not already running):
   ```bash
   npx tsx src/index.ts
   ```

2. Use MCP Inspector or send JSON-RPC messages over stdin to test tools

3. To manually launch Chrome instead (e.g. with `CHROME_AUTO_LAUNCH=false`):
   ```bash
   # macOS:
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
   # Linux:
   google-chrome --remote-debugging-port=9222
   ```

### Integration Testing

- Open a page with known console output and verify `get_console_logs` captures it
- Make a fetch request and verify `get_network_requests` captures URL, status, timing
- Query a known element and verify `get_elements` returns correct HTML
- Run `evaluate_js` with `1 + 1` and verify it returns `2`
- Test `wait_and_check` actually waits before returning results

## MCP Client Registration

**Claude Code** — add to `.mcp.json` or `.claude/settings.json`:

```json
{
  "mcpServers": {
    "relay-inspect": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/relay-inspect-mcp"
    }
  }
}
```

**Codex CLI:**

```bash
codex mcp add relay-inspect -- node /absolute/path/to/relay-inspect-mcp/dist/index.js
```

**opencode** — add to `opencode.json`:

```json
{
  "mcp": {
    "relay-inspect": {
      "type": "local",
      "command": "node",
      "args": ["dist/index.js"],
      "env": {},
      "cwd": "/absolute/path/to/relay-inspect-mcp"
    }
  }
}
```

During development with tsx:

```json
{
  "mcpServers": {
    "relay-inspect": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/absolute/path/to/relay-inspect-mcp"
    }
  }
}
```

## Conventions

- All tools return JSON strings wrapped in MCP text content blocks
- Use stderr for logging (stdout is reserved for MCP protocol)
- Don't install unnecessary dependencies — this should stay lean
- Type everything — no `any` types
- Handle all CDP events defensively — Chrome can send unexpected data
- Format network timing in milliseconds, round to 2 decimal places
- Truncate response bodies at 10KB by default, note when truncated

## Key Documentation

- Chrome DevTools Protocol: https://chromedevtools.github.io/devtools-protocol/
- MCP specification: https://spec.modelcontextprotocol.io/
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- chrome-remote-interface: https://github.com/cyrus-and/chrome-remote-interface

## Development Workflow

The whole point of this tool is enabling a tight feedback loop:

1. The agent edits source code
2. Dev server hot-reloads
3. The agent calls `wait_and_check` to let the reload complete
4. The agent reads console/network/DOM to verify the change
5. Repeat

Keep this loop in mind — every design decision should make this cycle faster and more reliable.
