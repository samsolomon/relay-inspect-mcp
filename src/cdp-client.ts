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
  private connected = false;
  private reconnecting = false;

  readonly consoleLogs: CircularBuffer<ConsoleEntry>;
  readonly networkRequests: CircularBuffer<NetworkEntry>;
  private pendingRequests = new Map<string, PendingRequest>();

  constructor() {
    this.consoleLogs = new CircularBuffer<ConsoleEntry>(config.consoleBufferSize);
    this.networkRequests = new CircularBuffer<NetworkEntry>(config.networkBufferSize);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): CDP.Client | null {
    return this.client;
  }

  async connect(): Promise<void> {
    const maxRetries = 3;
    let delay = 500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.error(`[relay-inspect] Connecting to Chrome at ${config.host}:${config.port} (attempt ${attempt}/${maxRetries})...`);
        this.client = await CDP({ host: config.host, port: config.port });
        this.connected = true;
        console.error(`[relay-inspect] Connected to Chrome.`);

        await this.enableDomains();
        this.attachEventHandlers();
        this.attachDisconnectHandler();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[relay-inspect] Connection attempt ${attempt} failed: ${message}`);

        if (attempt < maxRetries) {
          await sleep(delay);
          delay = Math.min(delay * 2, 10000);
        }
      }
    }

    console.error(`[relay-inspect] Could not connect to Chrome after ${maxRetries} attempts. Server will start without Chrome connection.`);
  }

  private async enableDomains(): Promise<void> {
    if (!this.client) return;

    await Promise.all([
      this.client.Runtime.enable(),
      this.client.Network.enable({}),
      this.client.DOM.enable({}),
      this.client.Page.enable(),
      this.client.Log.enable(),
    ]);

    console.error("[relay-inspect] CDP domains enabled: Runtime, Network, DOM, Page, Log");
  }

  private attachEventHandlers(): void {
    if (!this.client) return;

    // Console API calls (console.log, console.warn, console.error, etc.)
    this.client.Runtime.consoleAPICalled((params) => {
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
    this.client.Log.entryAdded((params) => {
      this.consoleLogs.push({
        timestamp: new Date(params.entry.timestamp).toISOString(),
        level: params.entry.level,
        message: `[browser] ${params.entry.text}`,
      });
    });

    // Network: request will be sent
    this.client.Network.requestWillBeSent((params) => {
      this.pendingRequests.set(params.requestId, {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: new Date(params.wallTime * 1000).toISOString(),
        startTime: params.timestamp,
      });
    });

    // Network: response received
    this.client.Network.responseReceived((params) => {
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
    this.client.Network.loadingFailed((params) => {
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

  private attachDisconnectHandler(): void {
    if (!this.client) return;

    this.client.on("disconnect", () => {
      console.error("[relay-inspect] Chrome disconnected.");
      this.connected = false;
      this.client = null;

      if (!this.reconnecting) {
        this.reconnecting = true;
        setTimeout(async () => {
          this.reconnecting = false;
          await this.connect();
        }, 3000);
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const cdpClient = new CDPClient();
