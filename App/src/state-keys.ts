import type { ScopeKey } from "@paperclipai/plugin-sdk";

const NAMESPACE = "openclaw-bridge";

const instance = (stateKey: string): ScopeKey => ({
  scopeKind: "instance",
  namespace: NAMESPACE,
  stateKey,
});

const company = (companyId: string, stateKey: string): ScopeKey => ({
  scopeKind: "company",
  scopeId: companyId,
  namespace: NAMESPACE,
  stateKey,
});

export const StateKeys = {
  config: instance("config"),
  reconnectBackoff: instance("reconnect-backoff"),
  lastSyncAt: (companyId: string) => company(companyId, "last-sync-at"),
  lastError: (companyId: string) => company(companyId, "last-error"),
  agentsSummary: (companyId: string) => company(companyId, "agents-summary"),
  openclawHealth: (companyId: string) => company(companyId, "openclaw-health"),
  // OpenClaw agent name -> managed slot key (e.g. { "main": "openclaw-slot-1" })
  slotAssignments: (companyId: string) => company(companyId, "slot-assignments"),
  /**
   * Per-company opt-in binding for the bridge. Persisted shape:
   *   {
   *     enabled: boolean,
   *     workspaces: string[]    // empty array = "all workspaces"
   *   }
   * Absent => not bound (the bridge skips this company on sync).
   */
  binding: (companyId: string) => company(companyId, "binding"),
  /**
   * Persisted bootstrap state: which PC API key the bridge claimed for OC,
   * when, and where the credential file was written. Used by the UI to show
   * "bootstrapped at <date>" instead of forcing the operator to remember.
   */
  bootstrap: (companyId: string) => company(companyId, "bootstrap"),
} as const;
