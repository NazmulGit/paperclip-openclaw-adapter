import type { Agent } from "@paperclipai/plugin-sdk";
import type { AgentSyncRow, OpenClawAgentRecord } from "../types.js";

export interface DiffInput {
  /** All OpenClaw agents discovered from `agents.list`. */
  openclawAgents: OpenClawAgentRecord[];
  /** All Paperclip agents in the target company. */
  paperclipAgents: Agent[];
  /** When provided, restricts the Paperclip side to agents with this adapter type. */
  paperclipAdapterType?: string;
  /**
   * Identifier from `agent.metadata.paperclipManagedResource.pluginKey` that
   * marks a Paperclip agent as one of this plugin's managed slots. When set,
   * those agents are matched to an OpenClaw agent by slot mapping rather than
   * by raw `agent.name` (which is a static slot template like
   * `"OpenClaw Agent 1"`).
   */
  pluginKey?: string;
  /**
   * Mapping from slot key to OpenClaw agent name, e.g.
   * `{ "openclaw-slot-1": "antor", "openclaw-slot-2": "main" }`. Built by
   * `AgentSync` from `StateKeys.slotAssignments`.
   */
  slotKeyToOcName?: Record<string, string>;
}

export type PaperclipAgentRef = Pick<Agent, "id" | "name" | "role" | "adapterType">;

function toRef(agent: Agent): PaperclipAgentRef {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    adapterType: agent.adapterType,
  };
}

function readSlotKey(agent: Agent, pluginKey: string | undefined): string | null {
  if (!pluginKey) return null;
  const meta = agent.metadata as Record<string, unknown> | null | undefined;
  const marker = meta?.paperclipManagedResource as Record<string, unknown> | undefined;
  if (!marker) return null;
  if (marker.pluginKey !== pluginKey) return null;
  if (marker.resourceKind !== "agent") return null;
  return typeof marker.resourceKey === "string" ? marker.resourceKey : null;
}

/**
 * Pure: produce a row per logical agent across both sides, classifying drift.
 *
 * Rows are keyed by OpenClaw agent name. A Paperclip agent contributes to a
 * row in one of two ways:
 *   1. **Slot-bound (plugin-owned).** `agent.metadata.paperclipManagedResource`
 *      identifies it as one of our slots; the slot key resolves to an
 *      OpenClaw name via `slotKeyToOcName`. The row is keyed by that OC name.
 *   2. **By name.** Legacy / user-created agents are matched by raw
 *      `agent.name === openclaw.name`.
 *
 * Rows are sorted by name for stable output.
 */
export function diffAgents(input: DiffInput): AgentSyncRow[] {
  const adapterFilter = input.paperclipAdapterType ?? null;
  const pluginKey = input.pluginKey;
  const slotKeyToOcName = input.slotKeyToOcName ?? {};

  const ocByName = new Map<string, OpenClawAgentRecord>();
  for (const a of input.openclawAgents) ocByName.set(a.name, a);

  // Each entry: { rowKey (OC name), agentRef, slotKey | null }
  const pcEntries: Array<{ rowKey: string; ref: PaperclipAgentRef; slotKey: string | null }> = [];
  for (const a of input.paperclipAgents) {
    if (adapterFilter !== null && a.adapterType !== adapterFilter) continue;
    const slotKey = readSlotKey(a, pluginKey);
    const mappedOcName = slotKey ? slotKeyToOcName[slotKey] : undefined;
    if (slotKey && !mappedOcName) {
      // Slot agent that has no OC-name mapping (e.g. the OC agent it used to
      // mirror was deleted). Surface it as its own row keyed by slot key so
      // the UI can flag the orphan; reconcile will treat it as no-op (won't
      // re-export to OpenClaw).
      pcEntries.push({ rowKey: `[orphan-slot] ${slotKey}`, ref: toRef(a), slotKey });
      continue;
    }
    const rowKey = mappedOcName ?? a.name;
    pcEntries.push({ rowKey, ref: toRef(a), slotKey });
  }

  const pcByKey = new Map<string, { ref: PaperclipAgentRef; slotKey: string | null }>();
  for (const e of pcEntries) pcByKey.set(e.rowKey, { ref: e.ref, slotKey: e.slotKey });

  const keys = new Set<string>([...ocByName.keys(), ...pcByKey.keys()]);

  const rows: AgentSyncRow[] = [];
  for (const key of keys) {
    const oc = ocByName.get(key) ?? null;
    const pcEntry = pcByKey.get(key) ?? null;
    const pc = pcEntry?.ref ?? null;
    const slotKey = pcEntry?.slotKey ?? null;
    let state: AgentSyncRow["state"];
    if (oc && !pc) state = "openclaw-only";
    else if (!oc && pc) state = "paperclip-only";
    else if (oc && pc && rolesMatch(oc.role, pc.role)) state = "synced";
    else state = "drift";
    rows.push({
      name: key,
      state,
      openclaw: oc,
      paperclip: pc,
      slotKey,
      lastReconciledAt: null,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function rolesMatch(a?: string, b?: string): boolean {
  const norm = (v?: string) => (v ?? "general").trim().toLowerCase();
  // OpenClaw agents don't always expose a `role` field. Treat a missing role
  // on either side as the conventional default ("general") so synced
  // OpenClaw/Paperclip pairs aren't reported as drift just because OpenClaw
  // omits the field.
  return norm(a) === norm(b);
}
