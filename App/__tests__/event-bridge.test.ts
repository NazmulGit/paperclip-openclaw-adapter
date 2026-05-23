import { describe, expect, it, vi } from "vitest";
import type { Agent, Issue, PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { EventBridge } from "../src/events/event-bridge.js";
import type { BridgeConfig } from "../src/types.js";

function makeOpenClawStub() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers = new Map<string, Array<(p: unknown) => void | Promise<void>>>();
  return {
    calls,
    handlers,
    client: {
      rpc: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { ok: true };
      }),
      on: vi.fn((event: string, fn: (p: unknown) => void | Promise<void>) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(fn);
        return () => handlers.get(event)?.splice(handlers.get(event)!.indexOf(fn), 1);
      }),
    },
  };
}

function makeCtxStub(opts: {
  agentLookup?: (agentId: string) => Agent | null;
  issueLookup?: (issueId: string) => Issue | null;
} = {}) {
  const eventHandlers = new Map<string, Array<(e: PluginEvent) => void | Promise<void>>>();
  const comments: Array<{ issueId: string; body: string }> = [];
  const ctx = {
    agents: {
      get: vi.fn(async (agentId: string) => opts.agentLookup?.(agentId) ?? null),
    },
    issues: {
      get: vi.fn(async (issueId: string) => opts.issueLookup?.(issueId) ?? null),
      createComment: vi.fn(async (issueId: string, body: string) => {
        comments.push({ issueId, body });
        return { id: "c_x" };
      }),
    },
    events: {
      on: vi.fn((event: string, _filter: unknown, fn: (e: PluginEvent) => void | Promise<void>) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event)!.push(fn);
        return () => eventHandlers.get(event)?.splice(eventHandlers.get(event)!.indexOf(fn), 1);
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, eventHandlers, comments };
}

const config: BridgeConfig = {
  openclawUrl: "ws://x",
  openclawToken: "x",
  companyId: "c1",
  syncDirection: "bidirectional",
  conflictPolicy: "newest-wins",
  autoSyncCron: "*/5 * * * *",
  healthCheckCron: "*/1 * * * *",
};

function ocAgent(name: string): Agent {
  return { id: `agt_${name}`, name, role: "general", adapterType: "openclaw_gateway" } as unknown as Agent;
}

function localAgent(name: string): Agent {
  return { id: `agt_${name}`, name, role: "general", adapterType: "claude_local" } as unknown as Agent;
}

function evt<T>(eventType: string, payload: T): PluginEvent<T> {
  return {
    eventId: "e_1",
    eventType: eventType as PluginEvent["eventType"],
    occurredAt: new Date().toISOString(),
    companyId: "c1",
    payload,
  };
}

describe("EventBridge — Paperclip → OpenClaw", () => {
  it("notifies OpenClaw via `send` when a new issue is assigned to an openclaw_gateway agent", async () => {
    const oc = makeOpenClawStub();
    const { ctx } = makeCtxStub({ agentLookup: () => ocAgent("scout") });

    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    await bridge.onIssueCreated(evt("issue.created", { id: "iss_1", title: "Hello", assigneeAgentId: "agt_scout" }));

    expect(oc.calls).toEqual([
      {
        method: "send",
        params: {
          agentName: "scout",
          channelId: "system",
          text: "New Paperclip task assigned: Hello",
          context: { paperclipIssueId: "iss_1" },
        },
      },
    ]);
  });

  it("skips when assigned agent is not an openclaw_gateway type", async () => {
    const oc = makeOpenClawStub();
    const { ctx } = makeCtxStub({ agentLookup: () => localAgent("scout") });
    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    await bridge.onIssueCreated(evt("issue.created", { id: "i", title: "t", assigneeAgentId: "x" }));
    expect(oc.calls).toEqual([]);
  });

  it("skips when syncDirection blocks the PC→OC direction", async () => {
    const oc = makeOpenClawStub();
    const { ctx } = makeCtxStub({ agentLookup: () => ocAgent("scout") });
    const bridge = new EventBridge({
      ctx,
      openclaw: oc.client as never,
      config: { ...config, syncDirection: "openclaw-to-paperclip" },
    });
    await bridge.onIssueCreated(evt("issue.created", { id: "i", title: "t", assigneeAgentId: "x" }));
    expect(oc.calls).toEqual([]);
  });

  it("mirrors issue comments to OpenClaw memory.put", async () => {
    const oc = makeOpenClawStub();
    const { ctx } = makeCtxStub({
      issueLookup: () =>
        ({ id: "iss_1", assigneeAgentId: "agt_scout", title: "x" } as unknown as Issue),
      agentLookup: () => ocAgent("scout"),
    });
    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    await bridge.onIssueCommented(evt("issue.commented", { issueId: "iss_1", body: "PR #42 merged" }));
    expect(oc.calls.length).toBe(1);
    expect(oc.calls[0]!.method).toBe("memory.put");
  });

  it("mirrors run summaries to OpenClaw memory.put", async () => {
    const oc = makeOpenClawStub();
    const { ctx } = makeCtxStub({ agentLookup: () => ocAgent("scout") });
    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    await bridge.onRunCompleted(
      evt("agent.run.completed", { runId: "r1", agentId: "agt_scout", summary: "done" }),
    );
    expect(oc.calls[0]!.method).toBe("memory.put");
  });
});

describe("EventBridge — OpenClaw → Paperclip", () => {
  it("creates a Paperclip comment on text_done", async () => {
    const oc = makeOpenClawStub();
    const { ctx, comments } = makeCtxStub();
    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    await bridge.onOpenClawAgentEvent({
      type: "text_done",
      text: "I finished the task",
      context: { paperclipIssueId: "iss_42" },
    });
    expect(comments).toEqual([{ issueId: "iss_42", body: "I finished the task" }]);
  });

  it("creates a Paperclip comment on tool_call with formatted body", async () => {
    const oc = makeOpenClawStub();
    const { ctx, comments } = makeCtxStub();
    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    await bridge.onOpenClawAgentEvent({
      type: "tool_call",
      name: "browser_open",
      params: { url: "https://x" },
      context: { paperclipIssueId: "iss_42" },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("tool: browser_open");
    expect(comments[0]!.body).toContain("https://x");
  });

  it("ignores OpenClaw events without paperclipIssueId", async () => {
    const oc = makeOpenClawStub();
    const { ctx, comments } = makeCtxStub();
    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    await bridge.onOpenClawAgentEvent({ type: "text_done", text: "x" });
    expect(comments).toEqual([]);
  });
});

describe("EventBridge — attach/detach", () => {
  it("registers handlers for issue events when attached and clears them when detached", () => {
    const oc = makeOpenClawStub();
    const { ctx, eventHandlers } = makeCtxStub();
    const bridge = new EventBridge({ ctx, openclaw: oc.client as never, config });
    bridge.attach();
    expect(eventHandlers.get("issue.created")?.length).toBe(1);
    expect(eventHandlers.get("issue.comment.created")?.length).toBe(1);
    expect(eventHandlers.get("agent.run.finished")?.length).toBe(1);
    expect(eventHandlers.get("agent.run.failed")?.length).toBe(1);
    expect(oc.handlers.get("agent")?.length).toBe(1);
    bridge.detach();
    expect(eventHandlers.get("issue.created")?.length).toBe(0);
    expect(oc.handlers.get("agent")?.length).toBe(0);
  });
});
