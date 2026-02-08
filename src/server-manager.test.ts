import { describe, it, expect, afterEach } from "vitest";
import { ServerManager } from "./server-manager.js";

describe("ServerManager", () => {
  const mgr = new ServerManager();

  afterEach(async () => {
    // Clean up any running servers
    for (const s of mgr.list()) {
      if (s.running) await mgr.stop(s.id);
    }
  });

  it("starts a server and captures output", async () => {
    const result = mgr.start({ id: "echo", command: "echo", args: ["hello world"] });
    expect(result.success).toBe(true);

    // Wait for process to finish and output to be captured
    await new Promise((r) => setTimeout(r, 500));

    const logs = mgr.getLogs("echo");
    expect("error" in logs).toBe(false);
    if (!("error" in logs)) {
      expect(logs.entries.some((e) => e.text.includes("hello world"))).toBe(true);
      expect(logs.running).toBe(false);
    }
  });

  it("rejects duplicate server id while running", async () => {
    mgr.start({ id: "long", command: "sleep", args: ["10"] });
    const dup = mgr.start({ id: "long", command: "echo", args: ["nope"] });
    expect(dup.success).toBe(false);
    expect(dup.error).toMatch(/already running/);
  });

  it("returns error for unknown server id", () => {
    const logs = mgr.getLogs("nonexistent");
    expect("error" in logs).toBe(true);
  });

  it("stops a running server", async () => {
    mgr.start({ id: "sleeper", command: "sleep", args: ["60"] });
    await new Promise((r) => setTimeout(r, 200));

    const result = await mgr.stop("sleeper");
    expect(result.success).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    const logs = mgr.getLogs("sleeper");
    if (!("error" in logs)) {
      expect(logs.running).toBe(false);
    }
  });

  it("lists servers", () => {
    mgr.start({ id: "listed", command: "echo", args: ["hi"] });
    const list = mgr.list();
    expect(list.some((s) => s.id === "listed")).toBe(true);
  });

  it("captures stderr output", async () => {
    mgr.start({ id: "stderr-test", command: "node", args: ["-e", "console.error('oops')"] });
    await new Promise((r) => setTimeout(r, 500));

    const logs = mgr.getLogs("stderr-test");
    if (!("error" in logs)) {
      expect(logs.entries.some((e) => e.stream === "stderr" && e.text.includes("oops"))).toBe(true);
    }
  });

  it("drain clears logs, peek does not", async () => {
    mgr.start({ id: "drain-test", command: "echo", args: ["data"] });
    await new Promise((r) => setTimeout(r, 500));

    // Peek should not clear
    const peeked = mgr.getLogs("drain-test", false);
    if (!("error" in peeked)) {
      expect(peeked.entries.length).toBeGreaterThan(0);
    }

    // Drain should clear
    const drained = mgr.getLogs("drain-test", true);
    if (!("error" in drained)) {
      expect(drained.entries.length).toBeGreaterThan(0);
    }

    // Second drain should be empty
    const empty = mgr.getLogs("drain-test", true);
    if (!("error" in empty)) {
      expect(empty.entries.length).toBe(0);
    }
  });
});
