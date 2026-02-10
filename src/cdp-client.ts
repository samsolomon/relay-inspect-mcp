import CDP from "chrome-remote-interface";

// --- Types ---

export interface ConsoleEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface NetworkEntry {
  id: string;
  url: string;
  method: string;
  status: number | null;
  timing_ms: number | null;
  error: string | null;
  timestamp: string;
}

// --- Circular Buffer ---

export class CircularBuffer<T> {
  private buffer: T[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  drain(): T[] {
    const items = this.buffer;
    this.buffer = [];
    return items;
  }

  peek(): T[] {
    return [...this.buffer];
  }

  get length(): number {
    return this.buffer.length;
  }
}

// --- Config ---

const config = {
  host: process.env.CHROME_DEBUG_HOST ?? "localhost",
  port: parseInt(process.env.CHROME_DEBUG_PORT ?? "9222", 10),
  consoleBufferSize: parseInt(process.env.CONSOLE_BUFFER_SIZE ?? "500", 10),
  networkBufferSize: parseInt(process.env.NETWORK_BUFFER_SIZE ?? "200", 10),
};

// --- Pending network request tracking ---

interface PendingRequest {
  id: string;
  url: string;
  method: string;
  timestamp: string;
  startTime: number;
}

// --- CDP Client ---

export class CDPClient {
  private client: CDP.Client | null = null;
  private connectingPromise: Promise<CDP.Client> | null = null;

  readonly consoleLogs: CircularBuffer<ConsoleEntry>;
  readonly networkRequests: CircularBuffer<NetworkEntry>;
  private pendingRequests = new Map<string, PendingRequest>();

  constructor() {
    this.consoleLogs = new CircularBuffer<ConsoleEntry>(config.consoleBufferSize);
    this.networkRequests = new CircularBuffer<NetworkEntry>(config.networkBufferSize);
  }

  /**
   * Returns an active CDP client, connecting or reconnecting as needed.
   * Throws if Chrome is unreachable after retries.
   */
  async ensureConnected(): Promise<CDP.Client> {
    // Fast path: existing connection is alive
    if (this.client) {
      if (await this.isAlive(this.client)) {
        return this.client;
      }
      // Stale connection — clean up before reconnecting
      console.error("[relay-inspect] Stale connection detected, reconnecting...");
      this.cleanup();
    }

    // Deduplicate concurrent connection attempts
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this.connect();
    try {
      return await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async isAlive(client: CDP.Client): Promise<boolean> {
    try {
      await client.Browser.getVersion();
      return true;
    } catch {
      return false;
    }
  }

  private cleanup(): void {
    if (this.client) {
      try { this.client.close(); } catch { /* already closed */ }
      this.client = null;
    }
    this.pendingRequests.clear();
  }

  private async connect(): Promise<CDP.Client> {
    const maxRetries = 3;
    let delay = 500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.error(`[relay-inspect] Connecting to Chrome at ${config.host}:${config.port} (attempt ${attempt}/${maxRetries})...`);

        // Discover targets via HTTP (fresh every time — never cached)
        const targets = await CDP.List({ host: config.host, port: config.port });
        const pageTargets = targets.filter((t: { type: string }) => t.type === "page");
        const skipPrefixes = ["devtools://", "chrome://", "chrome-extension://"];
        const webPages = pageTargets.filter(
          (t: { url: string }) =>
            (t.url.startsWith("http://") || t.url.startsWith("https://")) &&
            !skipPrefixes.some((prefix) => t.url.startsWith(prefix))
        );
        // Prefer localhost/127.0.0.1 (likely the dev server)
        const preferred = webPages.find(
          (t: { url: string }) =>
            t.url.startsWith("http://localhost") || t.url.startsWith("http://127.0.0.1")
        ) ?? webPages[0] ?? pageTargets[0];

        let client: CDP.Client;
        if (preferred) {
          console.error(`[relay-inspect] Selected target: ${preferred.url}`);
          client = await CDP({ host: config.host, port: config.port, target: preferred.id });
        } else {
          console.error(`[relay-inspect] No page targets found, using default target.`);
          client = await CDP({ host: config.host, port: config.port });
        }

        this.client = client;
        console.error(`[relay-inspect] Connected to Chrome.`);

        await this.enableDomains(client);
        this.attachEventHandlers(client);
        this.attachDisconnectHandler(client);
        return client;
      } catch (err) {
        // Clean up any partial connection from this attempt
        this.cleanup();

        const message = err instanceof Error ? err.message : String(err);
        console.error(`[relay-inspect] Connection attempt ${attempt} failed: ${message}`);

        if (attempt < maxRetries) {
          await sleep(delay);
          delay = Math.min(delay * 2, 10000);
        }
      }
    }

    throw new Error(
      `Could not connect to Chrome at ${config.host}:${config.port} after ${maxRetries} attempts. ` +
      `Ensure Chrome is running with --remote-debugging-port=${config.port}.`
    );
  }

  private async enableDomains(client: CDP.Client): Promise<void> {
    await Promise.all([
      client.Runtime.enable(),
      client.Network.enable({}),
      client.DOM.enable({}),
      client.Page.enable(),
      client.Log.enable(),
    ]);

    console.error("[relay-inspect] CDP domains enabled: Runtime, Network, DOM, Page, Log");
  }

  private attachEventHandlers(client: CDP.Client): void {
    // Console API calls (console.log, console.warn, console.error, etc.)
    client.Runtime.consoleAPICalled((params) => {
      const message = params.args
        .map((arg) => {
          if (arg.type === "string") return arg.value as string;
          if (arg.type === "undefined") return "undefined";
          if (arg.value !== undefined) return JSON.stringify(arg.value);
          if (arg.description) return arg.description;
          return `[${arg.type}]`;
        })
        .join(" ");

      this.consoleLogs.push({
        timestamp: new Date(params.timestamp).toISOString(),
        level: params.type,
        message,
      });
    });

    // Browser-level log entries
    client.Log.entryAdded((params) => {
      this.consoleLogs.push({
        timestamp: new Date(params.entry.timestamp).toISOString(),
        level: params.entry.level,
        message: `[browser] ${params.entry.text}`,
      });
    });

    // Network: request will be sent
    client.Network.requestWillBeSent((params) => {
      this.pendingRequests.set(params.requestId, {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: new Date(params.wallTime * 1000).toISOString(),
        startTime: params.timestamp,
      });
    });

    // Network: response received
    client.Network.responseReceived((params) => {
      const pending = this.pendingRequests.get(params.requestId);
      if (!pending) return;

      this.pendingRequests.delete(params.requestId);

      const timing_ms = Math.round((params.timestamp - pending.startTime) * 1000 * 100) / 100;

      this.networkRequests.push({
        id: pending.id,
        url: pending.url,
        method: pending.method,
        status: params.response.status,
        timing_ms,
        error: null,
        timestamp: pending.timestamp,
      });
    });

    // Network: loading failed
    client.Network.loadingFailed((params) => {
      const pending = this.pendingRequests.get(params.requestId);
      if (!pending) return;

      this.pendingRequests.delete(params.requestId);

      const timing_ms = Math.round((params.timestamp - pending.startTime) * 1000 * 100) / 100;

      this.networkRequests.push({
        id: pending.id,
        url: pending.url,
        method: pending.method,
        status: null,
        timing_ms,
        error: params.errorText,
        timestamp: pending.timestamp,
      });
    });
  }

  private attachDisconnectHandler(client: CDP.Client): void {
    client.on("disconnect", () => {
      console.error("[relay-inspect] Chrome disconnected.");
      this.client = null;
      this.pendingRequests.clear();
      // No auto-reconnect — next ensureConnected() call will reconnect lazily
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const cdpClient = new CDPClient();
