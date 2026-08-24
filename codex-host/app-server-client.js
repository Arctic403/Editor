import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 20_000;

export class CodexAppServerClient {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Set();
    this.stderrTail = [];
  }

  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.#start();
    try {
      await this.ready;
      return this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  async request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.ensureReady();
    const id = this.nextId++;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write(message);
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not running.");
    this.#write({ method, params });
  }

  onNotification(handler) {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  async account() {
    const result = await this.request("account/read", { refreshToken: false });
    return result?.account ?? null;
  }

  async startDeviceLogin() {
    return this.request("account/login/start", { type: "chatgptDeviceCode" }, 30_000);
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.child = null;
    this.ready = null;
  }

  async #start() {
    const codexPath = await resolveCodexBinary(this.cwd);
    const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.slice(-6).join("\n");
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).${detail ? `\n${detail}` : ""}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", line => this.#handleLine(line));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });

    await waitForSpawn(child);
    const initialized = await this.requestWithoutEnsure("initialize", {
      clientInfo: {
        name: "riftcity_mobile_editor",
        title: "RiftCity Mobile Editor",
        version: "1.0.0"
      },
      capabilities: { experimentalApi: true }
    }, 30_000);
    this.notify("initialized", {});
    return initialized;
  }

  requestWithoutEnsure(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error("Codex app-server stdin is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch (_) { return; }

    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const text = message.error?.message || JSON.stringify(message.error);
        pending.reject(new Error(text));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method) {
      for (const handler of this.notifications) {
        try { handler(message); } catch (_) {}
      }
    }
  }
}

async function resolveCodexBinary(cwd) {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;
  const binName = process.platform === "win32" ? "codex.cmd" : "codex";
  const candidates = [
    path.join(cwd, "node_modules", ".bin", binName),
    path.join(process.cwd(), "node_modules", ".bin", binName),
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch (_) {}
  }
  return "codex";
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    if (child.pid) return resolve();
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
