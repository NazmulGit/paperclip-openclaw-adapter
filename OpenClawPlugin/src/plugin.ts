// OpenClaw plugin: paperclip-bridge
//
// Registers a `paperclip` tool family so OpenClaw agents can call Paperclip
// from inside a session without writing raw fetch / Bearer-token boilerplate.
// Pairs with the Paperclip-side plugin paperclip-openclaw-bridge.
//
// Build:    pnpm build  (or tsc)
// Install:  openclaw plugins install ./
//
// This module exports `registerPaperclipBridgePlugin(api)`. OpenClaw discovers
// the entry via openclaw.plugin.json's contracts.tools and invokes the
// registration function on plugin activation.

// The OpenClaw plugin SDK is consumed via the subpath import map declared by
// the OC runtime — see Upstream/openclaw/packages/plugin-sdk/. The exact type
// surface is huge; we intentionally type narrowly here so the scaffold builds
// without depending on the full SDK package.
interface OpenClawPluginApi {
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  readonly pluginConfig: Record<string, unknown>;
  registerTool(
    factory: (ctx: ToolContext) => ToolDefinition,
    options: { name: string },
  ): void;
}

interface ToolContext {
  readonly runtimeConfig?: Record<string, unknown>;
  readonly session?: { id?: string };
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  invoke(input: Record<string, unknown>): Promise<{
    ok: boolean;
    result?: unknown;
    error?: string;
  }>;
}

interface PaperclipConfig {
  baseUrl: string;
  apiKey?: string;
  defaultCompanyId?: string;
  defaultAgentId?: string;
}

function readConfig(api: OpenClawPluginApi): PaperclipConfig {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl.length > 0
    ? raw.baseUrl.replace(/\/+$/, "")
    : "http://127.0.0.1:3100";
  return {
    baseUrl,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    defaultCompanyId: typeof raw.defaultCompanyId === "string" ? raw.defaultCompanyId : undefined,
    defaultAgentId: typeof raw.defaultAgentId === "string" ? raw.defaultAgentId : undefined,
  };
}

async function paperclipFetch(
  cfg: PaperclipConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave json null */ }
  return { ok: res.ok, status: res.status, json, text };
}

export function registerPaperclipBridgePlugin(api: OpenClawPluginApi): void {
  api.logger.info("paperclip-bridge: registering tool");

  api.registerTool(
    (_ctx) => buildPaperclipTool(readConfig(api), api),
    { name: "paperclip" },
  );
}

function buildPaperclipTool(cfg: PaperclipConfig, api: OpenClawPluginApi): ToolDefinition {
  return {
    name: "paperclip",
    description:
      "Talk to Paperclip from inside an OpenClaw session: comment on an issue, change its status, or create a new issue. " +
      "Requires that the OpenClaw runtime config for this plugin carries a valid Paperclip API key.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["op"],
      properties: {
        op: {
          type: "string",
          enum: ["commentIssue", "createIssue", "setIssueStatus", "ping"],
          description:
            "commentIssue: post a comment on issue {issueId, body}. " +
            "createIssue: open a new issue {companyId?, title, description?, priority?, assigneeAgentId?}. " +
            "setIssueStatus: update {issueId, status, comment?}. " +
            "ping: probe Paperclip reachability.",
        },
        companyId: { type: "string" },
        issueId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        comment: { type: "string" },
        status: {
          type: "string",
          enum: ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"],
        },
        priority: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
        assigneeAgentId: { type: "string" },
      },
    },
    invoke: async (input) => {
      const op = String(input.op ?? "");
      try {
        switch (op) {
          case "ping": {
            const r = await paperclipFetch(cfg, "GET", "/api/agents/me");
            return {
              ok: r.ok,
              result: r.ok ? r.json : undefined,
              error: r.ok ? undefined : `HTTP ${r.status}: ${r.text.slice(0, 240)}`,
            };
          }
          case "commentIssue": {
            const issueId = requireString(input, "issueId");
            const body = requireString(input, "body");
            const r = await paperclipFetch(cfg, "POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body });
            return {
              ok: r.ok,
              result: r.ok ? r.json : undefined,
              error: r.ok ? undefined : `HTTP ${r.status}: ${r.text.slice(0, 240)}`,
            };
          }
          case "setIssueStatus": {
            const issueId = requireString(input, "issueId");
            const status = requireString(input, "status");
            const comment = typeof input.comment === "string" ? input.comment : undefined;
            const r = await paperclipFetch(
              cfg,
              "PATCH",
              `/api/issues/${encodeURIComponent(issueId)}`,
              comment ? { status, comment } : { status },
            );
            return {
              ok: r.ok,
              result: r.ok ? r.json : undefined,
              error: r.ok ? undefined : `HTTP ${r.status}: ${r.text.slice(0, 240)}`,
            };
          }
          case "createIssue": {
            const companyId =
              (typeof input.companyId === "string" && input.companyId) ||
              cfg.defaultCompanyId ||
              null;
            if (!companyId) {
              return {
                ok: false,
                error: "createIssue requires companyId (pass it explicitly or set defaultCompanyId in plugin config)",
              };
            }
            const title = requireString(input, "title");
            const description = typeof input.description === "string" ? input.description : "";
            const priority = typeof input.priority === "string" ? input.priority : "medium";
            const assigneeAgentId =
              (typeof input.assigneeAgentId === "string" && input.assigneeAgentId) ||
              cfg.defaultAgentId ||
              undefined;
            const body = {
              title,
              description,
              status: "todo" as const,
              priority,
              ...(assigneeAgentId ? { assigneeAgentId } : {}),
            };
            const r = await paperclipFetch(
              cfg,
              "POST",
              `/api/companies/${encodeURIComponent(companyId)}/issues`,
              body,
            );
            return {
              ok: r.ok,
              result: r.ok ? r.json : undefined,
              error: r.ok ? undefined : `HTTP ${r.status}: ${r.text.slice(0, 240)}`,
            };
          }
          default:
            return { ok: false, error: `unknown op: ${op}` };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.warn("paperclip tool invocation failed", { op, err: msg });
        return { ok: false, error: msg };
      }
    },
  };
}

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`paperclip tool: '${key}' is required`);
  }
  return v;
}
