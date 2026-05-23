import type { AgentSyncRow, ConflictPolicy, SyncDirection } from "../types.js";

export type ReconcileAction =
  | {
      kind: "advertise-import";
      name: string;
      reason: "openclaw-only";
      openclawAgent: NonNullable<AgentSyncRow["openclaw"]>;
    }
  | {
      kind: "export-to-openclaw";
      name: string;
      reason: "paperclip-only";
      paperclip: NonNullable<AgentSyncRow["paperclip"]>;
    }
  | {
      kind: "noop-synced";
      name: string;
    }
  | {
      kind: "needs-review";
      name: string;
      reason: "drift";
      openclawAgent: NonNullable<AgentSyncRow["openclaw"]>;
      paperclip: NonNullable<AgentSyncRow["paperclip"]>;
      preferredSide: "openclaw" | "paperclip" | "manual";
    };

export interface ReconcileInput {
  rows: AgentSyncRow[];
  syncDirection: SyncDirection;
  conflictPolicy: ConflictPolicy;
}

/**
 * Pure: turn a diff into a planned set of actions, respecting sync direction
 * and conflict policy. The plugin doesn't have ctx.agents.create at V1, so
 * "openclaw-only" rows are surfaced as "advertise-import" — the UI offers the
 * operator a copy-pastable Paperclip adapter snippet.
 */
export function planReconcile(input: ReconcileInput): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  for (const row of input.rows) {
    switch (row.state) {
      case "synced":
        actions.push({ kind: "noop-synced", name: row.name });
        break;
      case "openclaw-only": {
        if (input.syncDirection === "paperclip-to-openclaw") {
          actions.push({ kind: "noop-synced", name: row.name });
          break;
        }
        actions.push({
          kind: "advertise-import",
          name: row.name,
          reason: "openclaw-only",
          openclawAgent: row.openclaw!,
        });
        break;
      }
      case "paperclip-only": {
        if (input.syncDirection === "openclaw-to-paperclip") {
          actions.push({ kind: "noop-synced", name: row.name });
          break;
        }
        // Never export back a Paperclip agent that's actually one of our own
        // managed slots — that's an orphan slot whose source OpenClaw agent
        // got deleted. Re-creating it on OC would generate a feedback loop.
        if (row.slotKey) {
          actions.push({ kind: "noop-synced", name: row.name });
          break;
        }
        actions.push({
          kind: "export-to-openclaw",
          name: row.name,
          reason: "paperclip-only",
          paperclip: row.paperclip!,
        });
        break;
      }
      case "drift": {
        const preferredSide = preferenceFromPolicy(input.conflictPolicy, row);
        actions.push({
          kind: "needs-review",
          name: row.name,
          reason: "drift",
          openclawAgent: row.openclaw!,
          paperclip: row.paperclip!,
          preferredSide,
        });
        break;
      }
    }
  }
  return actions;
}

function preferenceFromPolicy(
  policy: ConflictPolicy,
  row: AgentSyncRow,
): "openclaw" | "paperclip" | "manual" {
  switch (policy) {
    case "paperclip-wins":
      return "paperclip";
    case "openclaw-wins":
      return "openclaw";
    case "manual":
      return "manual";
    case "newest-wins": {
      const ocAt = row.openclaw?.updatedAt ? Date.parse(row.openclaw.updatedAt) : NaN;
      const pcAt = row.paperclip ? 0 : NaN;
      if (Number.isNaN(ocAt) && Number.isNaN(pcAt)) return "manual";
      if (Number.isNaN(ocAt)) return "paperclip";
      if (Number.isNaN(pcAt)) return "openclaw";
      return ocAt >= pcAt ? "openclaw" : "paperclip";
    }
  }
}
