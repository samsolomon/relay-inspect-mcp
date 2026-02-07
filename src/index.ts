import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cdpClient } from "./cdp-client.js";

const server = new McpServer({
  name: "relay-inspect",
  version: "0.1.0",
});

// --- Helper ---

function notConnectedError(): string {
  return JSON.stringify(
    { error: "Chrome is not connected. Launch Chrome with --remote-debugging-port=9222 and retry." },
    null,
    2,
  );
}

// --- Tool: evaluate_js ---

server.tool(
  "evaluate_js",
  "Execute a JavaScript expression in the browser and return the result",
  { expression: z.string().describe("JavaScript expression to evaluate") },
  async ({ expression }) => {
    if (!cdpClient.isConnected()) {
      return { content: [{ type: "text", text: notConnectedError() }] };
    }

    const client = cdpClient.getClient()!;

    try {
      const result = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 10000,
      });

      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? "Unknown error";
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: text }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ result: result.result.value }, null, 2),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
      };
    }
  },
);

// --- Tool: get_console_logs ---

server.tool(
  "get_console_logs",
  "Return buffered console output (logs, warnings, errors) from the browser",
  {
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Clear the buffer after reading (default: true)"),
  },
  async ({ clear }) => {
    if (!cdpClient.isConnected()) {
      return { content: [{ type: "text", text: notConnectedError() }] };
    }

    const entries = clear
      ? cdpClient.consoleLogs.drain()
      : cdpClient.consoleLogs.peek();

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: entries.length, entries }, null, 2),
      }],
    };
  },
);

// --- Tool: get_network_requests ---

server.tool(
  "get_network_requests",
  "Return captured network requests and responses from the browser",
  {
    filter: z
      .string()
      .optional()
      .describe("URL substring filter — only return requests matching this string"),
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Clear the buffer after reading (default: true)"),
  },
  async ({ filter, clear }) => {
    if (!cdpClient.isConnected()) {
      return { content: [{ type: "text", text: notConnectedError() }] };
    }

    let entries = clear
      ? cdpClient.networkRequests.drain()
      : cdpClient.networkRequests.peek();

    if (filter) {
      entries = entries.filter((e) => e.url.includes(filter));
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: entries.length, entries }, null, 2),
      }],
    };
  },
);

// --- Tool: get_elements ---

server.tool(
  "get_elements",
  "Query the DOM with a CSS selector and return matching elements' outer HTML",
  {
    selector: z.string().describe("CSS selector to query"),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of elements to return (default: 10)"),
  },
  async ({ selector, limit }) => {
    if (!cdpClient.isConnected()) {
      return { content: [{ type: "text", text: notConnectedError() }] };
    }

    const client = cdpClient.getClient()!;

    try {
      const doc = await client.DOM.getDocument({ depth: 0 });
      const result = await client.DOM.querySelectorAll({
        nodeId: doc.root.nodeId,
        selector,
      });

      if (result.nodeIds.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { count: 0, elements: [], message: `No elements matched selector: "${selector}"` },
              null,
              2,
            ),
          }],
        };
      }

      const nodeIds = result.nodeIds.slice(0, limit);
      const elements: string[] = [];

      for (const nodeId of nodeIds) {
        try {
          const html = await client.DOM.getOuterHTML({ nodeId });
          elements.push(html.outerHTML);
        } catch {
          // Node may have become stale between query and getOuterHTML
          elements.push("<!-- stale node -->");
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            { count: elements.length, total_matches: result.nodeIds.length, elements },
            null,
            2,
          ),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
      };
    }
  },
);

// --- Tool: wait_and_check ---

server.tool(
  "wait_and_check",
  "Wait N seconds then return new console output captured during the wait (useful after page reload)",
  {
    seconds: z
      .number()
      .optional()
      .default(2)
      .describe("Seconds to wait before checking (default: 2)"),
  },
  async ({ seconds }) => {
    if (!cdpClient.isConnected()) {
      return { content: [{ type: "text", text: notConnectedError() }] };
    }

    // Drain stale entries
    cdpClient.consoleLogs.drain();

    // Wait for the specified duration
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

    // Capture what arrived during the wait
    const entries = cdpClient.consoleLogs.drain();

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          { waited_seconds: seconds, count: entries.length, entries },
          null,
          2,
        ),
      }],
    };
  },
);

// --- Start ---

async function main(): Promise<void> {
  console.error("[relay-inspect] Starting MCP server...");

  // Connect to Chrome (non-blocking — server starts regardless)
  await cdpClient.connect();

  // Start MCP stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[relay-inspect] MCP server running on stdio.");
}

main().catch((err) => {
  console.error("[relay-inspect] Fatal error:", err);
  process.exit(1);
});
