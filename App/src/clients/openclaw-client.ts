import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";

export interface ConnectOptions {
  url: string;
  token: string;
  clientName?: string;
  clientVersion?: string;
  /** Min/max protocol version we speak. Both default to 3. */
  minProtocol?: number;
  maxProtocol?: number;
  /** Reconnect backoff config. */
  reconnect?: {
    base?: number;
    cap?: number;
    enabled?: boolean;
  };
  /** Hook for tests/logging. */
  onLog?: (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
}

export interface RpcOptions {
  timeoutMs?: number;
}

interface PendingRpc {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type EventHandler = (payload: unknown) => void | Promise<void>;

interface ConnectFrame {
  type: "req" | "res" | "event" | "hello";
  id?: string;
  method?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; retryAfterMs?: number };
  event?: string;
  protocol?: number;
  server?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
}

const DEFAULT_RPC_TIMEOUT = 30_000;
const DEFAULT_BACKOFF_BASE = 1_000;
const DEFAULT_BACKOFF_CAP = 30_000;
// Send a low-cost RPC every 25s to keep the gateway from closing idle WS
// connections, and to surface a dead connection earlier than the 5-min sync
// cron would.
const KEEPALIVE_INTERVAL_MS = 25_000;

export class OpenClawClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRpc>();
  private handlers = new Map<string, Set<EventHandler>>();
  private opts: Required<Pick<ConnectOptions, "minProtocol" | "maxProtocol">> & ConnectOptions;
  private closed = false;
  private connecting = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private helloReceived = false;
  private latestHello: ConnectFrame | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(opts: ConnectOptions) {
    this.opts = {
      minProtocol: 4,
      maxProtocol: 4,
      ...opts,
    };
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.helloReceived;
  }

  helloSnapshot(): ConnectFrame | null {
    return this.latestHello;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("OpenClawClient is closed");
    // Coalesce concurrent connect() calls onto a single in-flight promise.
    // The previous `if (connecting) return;` silently succeeded for callers
    // that started before the handshake finished, which made stuck handshakes
    // look like successful connects to upstream code.
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
      this.connecting = false;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.connecting = true;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    this.helloReceived = false;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    ws.on("message", (data) => this.handleFrame(data));
    ws.on("close", () => this.handleClose());
    ws.on("error", (err) => this.log("error", `ws error: ${err.message}`));

    const offChallenge = this.on("connect.challenge", () => {
      offChallenge();
      this.sendConnectRequest().catch((err) =>
        this.log("error", "connect RPC failed", { err: err instanceof Error ? err.message : String(err) }),
      );
    });

    await this.awaitHello();
    this.reconnectAttempts = 0;
    this.startKeepalive();
  }

  /**
   * Best-effort, non-blocking reconnect. Safe to call from hot paths (e.g.
   * data handler polling) without waiting for the handshake.
   */
  ensureConnecting(): void {
    if (this.closed || this.isOpen() || this.connectPromise) return;
    this.connect().catch((err) =>
      this.log("warn", "background reconnect failed", {
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!this.isOpen()) return;
      this.rpc("health", {}, { timeoutMs: 5_000 }).catch(() => {
        // ping failure -> ws.on('close') will trigger reconnect anyway.
      });
    }, KEEPALIVE_INTERVAL_MS);
    // Don't keep the Node process alive solely for the keepalive timer.
    if (typeof this.keepaliveTimer.unref === "function") this.keepaliveTimer.unref();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private async sendConnectRequest(): Promise<void> {
    try {
      const helloOk = await this.rpc<unknown>(
        "connect",
        {
          minProtocol: this.opts.minProtocol,
          maxProtocol: this.opts.maxProtocol,
          client: {
            id: "gateway-client",
            displayName: this.opts.clientName ?? "openclaw-bridge",
            version: this.opts.clientVersion ?? "1.0.0",
            platform: "node",
            mode: "backend",
          },
          caps: ["events.agent", "events.presence", "events.shutdown"],
          auth: { token: this.opts.token },
          role: "operator",
          // operator.admin is required for agents.create (PC -> OC export). The
          // gateway downgrades on its own if the token doesn't carry the
          // scope; requesting it costs nothing when we can't have it.
          scopes: ["operator.read", "operator.write", "operator.admin"],
        },
        { timeoutMs: 10_000 },
      );
      this.helloReceived = true;
      this.latestHello = { type: "hello", payload: helloOk };
      this.dispatchEvent("hello", helloOk);
    } catch (err) {
      this.log("error", "connect rpc rejected", { err: err instanceof Error ? err.message : String(err) });
      this.ws?.close();
      throw err;
    }
  }

  async rpc<T = unknown>(method: string, params: unknown = {}, options: RpcOptions = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`OpenClaw WS not connected (rpc:${method})`);
    }
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer,
      });
      this.send({ type: "req", id, method, params });
    });
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  async ping(timeoutMs = 5_000): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.isOpen()) {
        return { ok: false, error: "not_connected" };
      }
      await this.rpc("health", {}, { timeoutMs });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  close(): void {
    this.closed = true;
    this.stopKeepalive();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("OpenClaw client closing"));
    }
    this.pending.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  /** Compute the next reconnect delay in ms. Exponential, capped, with jitter. */
  computeBackoff(attempt: number): number {
    const base = this.opts.reconnect?.base ?? DEFAULT_BACKOFF_BASE;
    const cap = this.opts.reconnect?.cap ?? DEFAULT_BACKOFF_CAP;
    const raw = Math.min(cap, base * Math.pow(2, Math.max(0, attempt)));
    const jitter = raw * 0.25 * Math.random();
    return Math.round(raw - jitter);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private send(frame: unknown): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.log("error", "ws send failed", { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleFrame(data: RawData): void {
    let frame: ConnectFrame;
    try {
      frame = JSON.parse(data.toString());
    } catch (err) {
      this.log("warn", "could not parse frame", { err: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (frame.type === "hello") {
      this.helloReceived = true;
      this.latestHello = frame;
      this.dispatchEvent("hello", frame);
      return;
    }

    if (frame.type === "res" && frame.id) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        const err = new Error(frame.error?.message ?? "OpenClaw RPC error");
        if (frame.error?.code) (err as { code?: string }).code = frame.error.code;
        pending.reject(err);
      }
      return;
    }

    if (frame.type === "event" && frame.event) {
      this.dispatchEvent(frame.event, frame.payload);
      return;
    }
  }

  private dispatchEvent(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      Promise.resolve(fn(payload)).catch((err) =>
        this.log("warn", `handler for ${event} threw`, { err: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  private async awaitHello(): Promise<void> {
    if (this.helloReceived) return;
    const ws = this.ws;
    if (!ws) throw new Error("ws missing");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        offHello?.();
        ws.off("error", onErr);
        ws.off("close", onClose);
        clearTimeout(timer);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const offHello = this.on("hello", () => settle(resolve));
      const onErr = (err: Error) => settle(() => reject(err));
      const onClose = (code: number, reason: Buffer) =>
        settle(() => reject(new Error(`OpenClaw closed during handshake (${code} ${reason.toString()})`)));
      const timer = setTimeout(
        () => settle(() => reject(new Error("OpenClaw handshake timeout (no hello)"))),
        10_000,
      );
      ws.once("error", onErr);
      ws.once("close", onClose);
    });
  }

  private handleClose(): void {
    this.helloReceived = false;
    this.stopKeepalive();
    if (this.closed) return;
    if (this.opts.reconnect?.enabled === false) return;
    // If a reconnect attempt is already running (or queued), don't pile on.
    if (this.connectPromise) return;

    const attempt = ++this.reconnectAttempts;
    const delay = this.computeBackoff(attempt - 1);
    this.log("warn", "ws closed, scheduling reconnect", { attempt, delayMs: delay });
    const timer = setTimeout(() => {
      if (this.closed) return;
      this.connect().catch((err) =>
        this.log("warn", "reconnect failed", { attempt, err: err instanceof Error ? err.message : String(err) }),
      );
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  private log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    if (this.opts.onLog) this.opts.onLog(level, message, meta);
  }
}
