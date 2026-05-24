import type { Agent } from "@paperclipai/plugin-sdk";

export type SyncDirection =
  | "bidirectional"
  | "openclaw-to-paperclip"
  | "paperclip-to-openclaw";

export type ConflictPolicy =
  | "newest-wins"
  | "paperclip-wins"
  | "openclaw-wins"
  | "manual";

export interface BridgeConfig {
  openclawUrl: string;
  openclawToken: string;
  companyId: string | null;
  syncDirection: SyncDirection;
  conflictPolicy: ConflictPolicy;
  autoSyncCron: string;
  healthCheckCron: string;
  /**
   * Loopback URL for the local Paperclip API. Used by the bridge to PATCH
   * managed-agent rows post-reconcile (rename + adapterConfig seeding).
   * Defaults to `http://127.0.0.1:3100`.
   */
  paperclipApiUrl?: string;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  openclawUrl: "ws://127.0.0.1:18789",
  openclawToken: "",
  companyId: null,
  syncDirection: "bidirectional",
  conflictPolicy: "newest-wins",
  autoSyncCron: "*/5 * * * *",
  healthCheckCron: "*/1 * * * *",
  paperclipApiUrl: "http://127.0.0.1:3100",
};

export interface OpenClawAgentRecord {
  name: string;
  model?: string;
  role?: string;
  systemPrompt?: string;
  updatedAt?: string;
  channelBindings?: string[];
  /** OpenClaw workspace this agent belongs to. */
  workspace?: string;
}

/** Normalized envelope returned by the OpenClaw `agents.list` RPC. */
export interface OpenClawAgentRoster {
  agents: OpenClawAgentRecord[];
  /** OpenClaw's default workspace name, used when creating new agents. */
  mainKey: string | null;
}

export type AgentRowState =
  | "openclaw-only"
  | "paperclip-only"
  | "synced"
  | "drift";

export interface AgentSyncRow {
  /**
   * Row identifier — the OpenClaw agent name when a row has an OpenClaw side
   * (or maps to one via slot assignment), otherwise the Paperclip agent name.
   */
  name: string;
  state: AgentRowState;
  openclaw: OpenClawAgentRecord | null;
  paperclip: Pick<Agent, "id" | "name" | "role" | "adapterType"> | null;
  /**
   * For Paperclip-side agents that this plugin owns (managed slots), the
   * stable slot key (e.g. `openclaw-slot-1`). Lets the UI surface the
   * OpenClaw-name → Paperclip-agent-name pairing.
   */
  slotKey: string | null;
  lastReconciledAt: string | null;
}

export interface SyncStatusSnapshot {
  lastSyncAt: number | null;
  lastError: { at: number; message: string } | null;
  rows: AgentSyncRow[];
  openclawHealthy: boolean | null;
  openclawHealthCheckedAt: number | null;
}

/**
 * Per-Paperclip-company opt-in for the bridge. When `enabled` is false (or
 * the binding is absent), syncs skip this company.
 *
 * - `agentNames`: explicit allowlist of OpenClaw agent names to mirror into
 *   this company. Empty array = "mirror every agent the gateway exposes"
 *   (still implicitly filtered by `workspaces` below when that's set).
 * - `workspaces`: legacy workspace filter — kept for back-compat with the
 *   v1.3 UI. Empty array = no workspace filter. The two filters are AND'd
 *   together at sync time.
 */
export interface CompanyBinding {
  enabled: boolean;
  agentNames: string[];
  workspaces: string[];
}

export const EMPTY_BINDING: CompanyBinding = {
  enabled: false,
  agentNames: [],
  workspaces: [],
};
