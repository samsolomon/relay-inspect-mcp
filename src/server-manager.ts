import { spawn, ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import { CircularBuffer } from "./cdp-client.js";

// --- Types ---

export interface LogEntry {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

interface ManagedServer {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  process: ChildProcess;
  logs: CircularBuffer<LogEntry>;
  startedAt: string;
  exitCode: number | null;
  running: boolean;
}

// --- Config ---

const LOG_BUFFER_SIZE = parseInt(process.env.SERVER_LOG_BUFFER_SIZE ?? "1000", 10);

// --- Server Manager ---

export class ServerManager {
  private servers = new Map<string, ManagedServer>();

  start(opts: {
    id: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): { success: boolean; error?: string } {
    const existing = this.servers.get(opts.id);
    if (existing?.running) {
      return { success: false, error: `Server "${opts.id}" is already running (pid ${existing.process.pid}).` };
    }

    const args = opts.args ?? [];
    const cwd = opts.cwd ?? process.cwd();

    // Combine command + args into a single shell string to avoid the
    // DEP0190 deprecation warning (shell: true + args array).
    const fullCommand = [opts.command, ...args].join(" ");

    const child = spawn(fullCommand, [], {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env, FORCE_COLOR: "0" },
    });

    const logs = new CircularBuffer<LogEntry>(LOG_BUFFER_SIZE);

    const pushLog = (stream: "stdout" | "stderr", data: Buffer) => {
      const text = data.toString();
      // Split on newlines so each line is a separate entry
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        logs.push({ timestamp: new Date().toISOString(), stream, text: line });
      }
    };

    child.stdout?.on("data", (data: Buffer) => pushLog("stdout", data));
    child.stderr?.on("data", (data: Buffer) => pushLog("stderr", data));

    const server: ManagedServer = {
      id: opts.id,
      command: opts.command,
      args,
      cwd,
      process: child,
      logs,
      startedAt: new Date().toISOString(),
      exitCode: null,
      running: true,
    };

    child.on("exit", (code) => {
      server.exitCode = code;
      server.running = false;
      console.error(`[relay-inspect] Server "${opts.id}" exited with code ${code}`);
    });

    child.on("error", (err) => {
      server.running = false;
      logs.push({ timestamp: new Date().toISOString(), stream: "stderr", text: `[spawn error] ${err.message}` });
      console.error(`[relay-inspect] Server "${opts.id}" spawn error: ${err.message}`);
    });

    this.servers.set(opts.id, server);
    console.error(`[relay-inspect] Started server "${opts.id}": ${opts.command} ${args.join(" ")} (pid ${child.pid})`);

    return { success: true };
  }

  getLogs(id: string, clear = true): { entries: LogEntry[]; running: boolean; exitCode: number | null } | { error: string } {
    const server = this.servers.get(id);
    if (!server) {
      return { error: `No server found with id "${id}". Use start_server first.` };
    }

    const entries = clear ? server.logs.drain() : server.logs.peek();
    return { entries, running: server.running, exitCode: server.exitCode };
  }

  async stop(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.servers.get(id);
    if (!server) {
      return { success: false, error: `No server found with id "${id}".` };
    }
    if (!server.running) {
      return { success: true, error: `Server "${id}" already stopped (exit code: ${server.exitCode}).` };
    }

    const pid = server.process.pid;
    if (!pid) {
      return { success: false, error: `Server "${id}" has no PID.` };
    }

    return new Promise((resolve) => {
      treeKill(pid, "SIGTERM", (err) => {
        if (err) {
          console.error(`[relay-inspect] Error killing server "${id}": ${err.message}`);
          resolve({ success: false, error: err.message });
        } else {
          console.error(`[relay-inspect] Stopped server "${id}" (pid ${pid})`);
          resolve({ success: true });
        }
      });
    });
  }

  list(): Array<{ id: string; command: string; running: boolean; pid: number | undefined; startedAt: string; exitCode: number | null }> {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.id,
      command: `${s.command} ${s.args.join(" ")}`.trim(),
      running: s.running,
      pid: s.process.pid,
      startedAt: s.startedAt,
      exitCode: s.exitCode,
    }));
  }
}

export const serverManager = new ServerManager();
