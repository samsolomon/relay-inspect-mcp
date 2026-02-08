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

Keep it minimal. Start with a single `src/index.ts` and only split when complexity demands it.

```
relay-inspect/
├── src/
│   ├── index.ts          # Entry point — MCP server setup and tool registration
│   ├── cdp-client.ts     # Chrome connection, event buffering, reconnection logic
│   └── tools/            # Split tools into separate files only if index.ts exceeds ~400 lines
│       ├── console.ts
│       ├── network.ts
│       ├── dom.ts
│       └── evaluate.ts
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

## MCP Tools to Implement

### Core Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_console_logs` | Return buffered console output since last call | `clear?: boolean` (default true — clears buffer after reading) |
| `get_network_requests` | Return captured network requests and responses | `filter?: string` (URL substring filter), `clear?: boolean` |
| `get_elements` | Query DOM and return matching HTML | `selector: string`, `limit?: number` |
| `evaluate_js` | Execute a JS expression in the browser and return the result | `expression: string` |
| `wait_and_check` | Wait N seconds then return new console output (for post-reload checks) | `seconds?: number` (default 2) |

### Nice-to-Have Tools (add later)

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

- Connect to Chrome on startup, retry with backoff if Chrome isn't running yet
- Handle Chrome disconnection gracefully — don't crash the server, queue a reconnect
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
CONSOLE_BUFFER_SIZE=500         # Max console entries to buffer (default: 500)
NETWORK_BUFFER_SIZE=200         # Max network requests to buffer (default: 200)
```

## Testing

### Manual Testing

1. Launch Chrome with remote debugging:
   ```bash
   google-chrome --remote-debugging-port=9222
   # or on macOS:
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
   ```

2. Run the server directly to test:
   ```bash
   npx tsx src/index.ts
   ```

3. Use MCP Inspector or send JSON-RPC messages over stdin to test tools

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
