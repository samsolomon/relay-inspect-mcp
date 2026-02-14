import { execSync, spawn, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import CDP from "chrome-remote-interface";
import treeKill from "tree-kill";

// --- Chrome Path Discovery ---

function findChromePathMacOS(): string | null {
  const paths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  return paths.find((p) => existsSync(p)) ?? null;
}

function findChromePathLinux(): string | null {
  const names = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
  for (const name of names) {
    try {
      const result = execSync(`which ${name}`, { encoding: "utf-8" }).trim();
      if (result) return result;
    } catch {
      // not found, try next
    }
  }
  return null;
}

function findChromePathWindows(): string | null {
  const paths = [
    join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  return paths.find((p) => existsSync(p)) ?? null;
}

export function findChromePath(): string | null {
  // Explicit override via env var
  const envPath = process.env.CHROME_PATH;
  if (envPath) {
    return existsSync(envPath) ? envPath : null;
  }

  const os = platform();
  if (os === "darwin") return findChromePathMacOS();
  if (os === "linux") return findChromePathLinux();
  if (os === "win32") return findChromePathWindows();
  return null;
}

// --- Auto-launch Config ---

export function isAutoLaunchEnabled(): boolean {
  const val = process.env.CHROME_AUTO_LAUNCH;
  if (val === undefined) return true;
  return val !== "false" && val !== "0";
}

// --- CDP Readiness Wait ---

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

async function waitForCDP(host: string, port: number, timeoutMs = 15000): Promise<void> {
  const interval = 500;
  const perCallTimeout = 3000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await withTimeout(CDP.Version({ host, port }), perCallTimeout);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  throw new Error(`Chrome CDP not ready after ${timeoutMs}ms on ${host}:${port}`);
}

// --- Launch Chrome ---

export async function launchChrome(port: number, host = "localhost"): Promise<ChildProcess> {
  const chromePath = findChromePath();
  if (!chromePath) {
    const hint = process.env.CHROME_PATH
      ? `CHROME_PATH="${process.env.CHROME_PATH}" does not exist.`
      : "Could not find Chrome. Set CHROME_PATH to the Chrome/Chromium executable path.";
    throw new Error(`Chrome not found. ${hint}`);
  }

  const userDataDir = join(tmpdir(), `relay-inspect-chrome-profile-${port}`);

  console.error(`[relay-inspect] Auto-launching Chrome: ${chromePath}`);
  console.error(`[relay-inspect]   --remote-debugging-port=${port}`);
  console.error(`[relay-inspect]   --user-data-dir=${userDataDir}`);

  const launchUrl = process.env.CHROME_LAUNCH_URL;

  const args = [
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${userDataDir}`,
  ];

  if (launchUrl) {
    args.push(launchUrl);
    console.error(`[relay-inspect]   Launch URL: ${launchUrl}`);
  }

  const child = spawn(chromePath, args, {
    stdio: "ignore",
    detached: true,
  });

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to spawn Chrome process (no PID assigned).");
  }

  console.error(`[relay-inspect] Chrome spawned with PID ${child.pid}, waiting for CDP...`);

  try {
    await waitForCDP(host, port);
  } catch (err) {
    // CDP never became ready — kill the process tree we just spawned
    try { treeKill(child.pid, "SIGTERM"); } catch { /* already dead */ }
    throw err;
  }

  console.error(`[relay-inspect] Chrome CDP is ready on ${host}:${port}.`);
  return child;
}
