import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { OpenClawClient } from "../clients/openclaw-client.js";
import type { BridgeConfig } from "../types.js";

const OPENCLAW_ADAPTER_TYPE = "openclaw_gateway";

export interface EventBridgeDeps {
  ctx: PluginContext;
  openclaw: OpenClawClient;
  config: BridgeConfig;
}

interface IssueCreatedPayload {
  id?: string;
  title?: string;
  assigneeAgentId?: string | null;
}

interface IssueCommentedPayload {
  issueId?: string;
  body?: string;
}

interface RunCompletedPayload {
  runId?: string;
  agentId?: string;
  summary?: string;
  issueId?: string | null;
}

interface OpenClawAgentEvent {
  type?: "tool_call" | "tool_result" | "text_delta" | "text_done" | "error" | "done";
  text?: string;
  name?: string;
  params?: unknown;
  context?: { paperclipIssueId?: string; paperclipCompanyId?: string };
}

/**
 * Bidirectional ambient event bridge.
 *
 * Paperclip → OpenClaw: notify the OpenClaw operator when a task is assigned
 * to an openclaw_gateway-backed agent, and mirror Paperclip comments as
 * lightweight notes on the OpenClaw side.
 *
 * OpenClaw → Paperclip: when OpenClaw emits `agent` events tagged with a
 * `paperclipIssueId`, append a comment to that issue.
 */
export class EventBridge {
  private readonly ctx: PluginContext;
  private readonly oc: OpenClawClient;
  private readonly config: BridgeConfig;
  private unsubs: Array<() => void> = [];

  constructor(deps: EventBridgeDeps) {
    this.ctx = deps.ctx;
    this.oc = deps.openclaw;
    this.config = deps.config;
  }

  attach(): void {
    // No per-company filter — we subscribe to every event and let the
    // handlers decide whether the issue's company has an enabled bridge
    // binding before mirroring anything to OpenClaw. Pre-2026.517 this
    // method required a single `config.companyId` filter; with multi-company
    // bindings that no longer fits, and the SDK's event delivery is cheap.
    this.unsubs.push(this.ctx.events.on("issue.created", {}, (e) => this.onIssueCreated(e)));
    this.unsubs.push(this.ctx.events.on("issue.comment.created", {}, (e) => this.onIssueCommented(e)));
    this.unsubs.push(this.ctx.events.on("agent.run.finished", {}, (e) => this.onRunCompleted(e)));
    this.unsubs.push(this.ctx.events.on("agent.run.failed", {}, (e) => this.onRunCompleted(e)));

    this.unsubs.push(this.oc.on("agent", (payload) => this.onOpenClawAgentEvent(payload)));
  }

  detach(): void {
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        // best-effort cleanup
      }
    }
    this.unsubs = [];
  }

  // ---- Paperclip → OpenClaw -----------------------------------------------

  /**
   * Resolve the company id for an inbound event. We accept it from either the
   * `companyId` top-level field (the modern envelope) or from the payload as
   * a fallback for older SDK builds. Returns null if the event isn't scoped
   * to a known company — those events are skipped.
   */
  private companyIdFor(event: PluginEvent): string | null {
    const ev = event as unknown as { companyId?: unknown; payload?: { companyId?: unknown } };
    if (typeof ev.companyId === "string" && ev.companyId.length > 0) return ev.companyId;
    if (typeof ev.payload?.companyId === "string" && ev.payload.companyId.length > 0) return ev.payload.companyId;
    return null;
  }

  private async isBound(companyId: string): Promise<boolean> {
    const binding = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      namespace: "openclaw-bridge",
      stateKey: "binding",
    });
    return Boolean((binding as { enabled?: boolean } | null)?.enabled);
  }

  async onIssueCreated(event: PluginEvent): Promise<void> {
    const payload = event.payload as IssueCreatedPayload | null;
    if (!payload?.assigneeAgentId) return;
    if (this.config.syncDirection === "openclaw-to-paperclip") return;
    const companyId = this.companyIdFor(event);
    if (!companyId || !(await this.isBound(companyId))) return;

    const agent = await safeGet(() => this.ctx.agents.get(payload.assigneeAgentId!, companyId));
    if (!agent || agent.adapterType !== OPENCLAW_ADAPTER_TYPE) return;

    const text = `New Paperclip task assigned: ${payload.title ?? "(untitled)"}`;
    await this.safeRpc("send", {
      agentName: agent.name,
      channelId: "system",
      text,
      context: { paperclipIssueId: payload.id ?? null },
    });
  }

  async onIssueCommented(event: PluginEvent): Promise<void> {
    const payload = event.payload as IssueCommentedPayload | null;
    if (!payload?.issueId || !payload.body) return;
    if (this.config.syncDirection === "openclaw-to-paperclip") return;
    const companyId = this.companyIdFor(event);
    if (!companyId || !(await this.isBound(companyId))) return;

    const issue = await safeGet(() => this.ctx.issues.get(payload.issueId!, companyId));
    if (!issue || !issue.assigneeAgentId) return;
    const agent = await safeGet(() => this.ctx.agents.get(issue.assigneeAgentId!, companyId));
    if (!agent || agent.adapterType !== OPENCLAW_ADAPTER_TYPE) return;

    await this.safeRpc("memory.put", {
      agentName: agent.name,
      key: `paperclip:issue:${payload.issueId}:comment:${Date.now()}`,
      value: payload.body,
    });
  }

  async onRunCompleted(event: PluginEvent): Promise<void> {
    const payload = event.payload as RunCompletedPayload | null;
    if (!payload?.runId || !payload.agentId) return;
    if (this.config.syncDirection === "openclaw-to-paperclip") return;
    const companyId = this.companyIdFor(event);
    if (!companyId || !(await this.isBound(companyId))) return;

    const agent = await safeGet(() => this.ctx.agents.get(payload.agentId!, companyId));
    if (!agent || agent.adapterType !== OPENCLAW_ADAPTER_TYPE) return;

    await this.safeRpc("memory.put", {
      agentName: agent.name,
      key: `paperclip:run:${payload.runId}`,
      value: payload.summary ?? "(no summary)",
    });
  }

  // ---- OpenClaw → Paperclip -----------------------------------------------

  async onOpenClawAgentEvent(payload: unknown): Promise<void> {
    if (this.config.syncDirection === "paperclip-to-openclaw") return;
    const evt = payload as OpenClawAgentEvent | null;
    if (!evt?.context?.paperclipIssueId) return;
    const companyId = typeof evt.context.paperclipCompanyId === "string" ? evt.context.paperclipCompanyId : null;
    if (!companyId || !(await this.isBound(companyId))) return;

    let body: string | null = null;
    if (evt.type === "text_done" && evt.text) {
      body = evt.text;
    } else if (evt.type === "tool_call" && evt.name) {
      const args = evt.params === undefined ? "" : JSON.stringify(evt.params, null, 2);
      body = `tool: ${evt.name}\n\n\`\`\`json\n${args}\n\`\`\``;
    } else if (evt.type === "error" && evt.text) {
      body = `OpenClaw error: ${evt.text}`;
    }
    if (!body) return;

    try {
      await this.ctx.issues.createComment(evt.context.paperclipIssueId, body, companyId);
    } catch (err) {
      this.ctx.logger.warn("event-bridge: createComment failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- helpers ------------------------------------------------------------

  private async safeRpc(method: string, params: unknown): Promise<void> {
    try {
      await this.oc.rpc(method, params);
    } catch (err) {
      this.ctx.logger.warn(`event-bridge: rpc ${method} failed (non-fatal)`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function safeGet<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
