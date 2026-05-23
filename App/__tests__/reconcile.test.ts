import { describe, expect, it } from "vitest";
import type { AgentSyncRow } from "../src/types.js";
import { planReconcile, type ReconcileAction } from "../src/sync/reconcile.js";

function row(state: AgentSyncRow["state"], extras: Partial<AgentSyncRow> = {}): AgentSyncRow {
  return {
    name: extras.name ?? "x",
    state,
    openclaw:
      state === "openclaw-only" || state === "drift" || state === "synced"
        ? { name: extras.name ?? "x", role: "general", updatedAt: "2026-05-01T00:00:00Z" }
        : null,
    paperclip:
      state === "paperclip-only" || state === "drift" || state === "synced"
        ? { id: "agt_x", name: extras.name ?? "x", role: "general", adapterType: "openclaw_gateway" }
        : null,
    slotKey: null,
    lastReconciledAt: null,
    ...extras,
  };
}

describe("planReconcile", () => {
  it("openclaw-only with bidirectional → advertise-import", () => {
    const actions = planReconcile({
      rows: [row("openclaw-only")],
      syncDirection: "bidirectional",
      conflictPolicy: "newest-wins",
    });
    expect(actions[0]!.kind).toBe("advertise-import");
  });

  it("openclaw-only when direction restricts to PC→OC → noop", () => {
    const actions = planReconcile({
      rows: [row("openclaw-only")],
      syncDirection: "paperclip-to-openclaw",
      conflictPolicy: "newest-wins",
    });
    expect(actions[0]!.kind).toBe("noop-synced");
  });

  it("paperclip-only with bidirectional → export-to-openclaw", () => {
    const actions = planReconcile({
      rows: [row("paperclip-only")],
      syncDirection: "bidirectional",
      conflictPolicy: "newest-wins",
    });
    expect(actions[0]!.kind).toBe("export-to-openclaw");
  });

  it("paperclip-only when direction restricts to OC→PC → noop", () => {
    const actions = planReconcile({
      rows: [row("paperclip-only")],
      syncDirection: "openclaw-to-paperclip",
      conflictPolicy: "newest-wins",
    });
    expect(actions[0]!.kind).toBe("noop-synced");
  });

  it("synced → noop-synced", () => {
    const actions = planReconcile({
      rows: [row("synced")],
      syncDirection: "bidirectional",
      conflictPolicy: "newest-wins",
    });
    expect(actions[0]!.kind).toBe("noop-synced");
  });

  it("drift+paperclip-wins → needs-review preferring paperclip", () => {
    const actions = planReconcile({
      rows: [row("drift")],
      syncDirection: "bidirectional",
      conflictPolicy: "paperclip-wins",
    });
    const a = actions[0]! as Extract<ReconcileAction, { kind: "needs-review" }>;
    expect(a.kind).toBe("needs-review");
    expect(a.preferredSide).toBe("paperclip");
  });

  it("drift+openclaw-wins → needs-review preferring openclaw", () => {
    const actions = planReconcile({
      rows: [row("drift")],
      syncDirection: "bidirectional",
      conflictPolicy: "openclaw-wins",
    });
    const a = actions[0]! as Extract<ReconcileAction, { kind: "needs-review" }>;
    expect(a.preferredSide).toBe("openclaw");
  });

  it("drift+manual → needs-review preferring manual", () => {
    const actions = planReconcile({
      rows: [row("drift")],
      syncDirection: "bidirectional",
      conflictPolicy: "manual",
    });
    const a = actions[0]! as Extract<ReconcileAction, { kind: "needs-review" }>;
    expect(a.preferredSide).toBe("manual");
  });

  it("drift+newest-wins picks openclaw when ocUpdatedAt > pcUpdatedAt", () => {
    const actions = planReconcile({
      rows: [row("drift")],
      syncDirection: "bidirectional",
      conflictPolicy: "newest-wins",
    });
    const a = actions[0]! as Extract<ReconcileAction, { kind: "needs-review" }>;
    expect(a.preferredSide).toBe("openclaw");
  });
});
