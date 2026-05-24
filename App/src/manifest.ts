import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "openclaw-bridge";
export const PLUGIN_VERSION = "2.0.0";

export const SETTINGS_PAGE_SLOT_ID = "openclaw-bridge-settings";
export const SETTINGS_PAGE_EXPORT = "SettingsPanel";

export const STATUS_WIDGET_SLOT_ID = "openclaw-bridge-status";
export const STATUS_WIDGET_EXPORT = "StatusWidget";

export const SYNC_JOB_KEY = "openclaw-sync";
export const HEALTH_JOB_KEY = "openclaw-health-check";

export const TOOL_LIST_CHANNELS = "list-openclaw-channels";

export const DATA_SYNC_STATUS = "sync-status";
export const DATA_OPENCLAW_AGENTS = "openclaw-agents";
export const DATA_OPENCLAW_WORKSPACES = "openclaw-workspaces";
export const DATA_COMPANY_BINDING = "company-binding";

export const ACTION_RUN_SYNC = "run-sync";
export const ACTION_TEST_CONNECTION = "test-connection";
export const ACTION_SAVE_CONFIG = "save-config";
export const ACTION_SAVE_BINDING = "save-binding";
export const ACTION_CHAT_SEND = "chat-send";
export const ACTION_CHAT_HISTORY = "chat-history";
export const ACTION_SAVE_BULK = "save-bulk";
export const ACTION_BOOTSTRAP_TOKEN = "bootstrap-token";
export const ACTION_UPDATE_GATEWAY_CONFIG = "update-gateway-config";
export const DATA_COMPANIES = "paperclip-companies";
export const DATA_ALL_BINDINGS = "all-bindings";
export const DATA_BOOTSTRAP_STATUS = "bootstrap-status";
export const DATA_GATEWAY_CONFIG = "gateway-config";
export const DATA_OPENCLAW_MODELS = "openclaw-models";

/**
 * The number of managed-agent slots this plugin declares. Each discovered
 * OpenClaw agent (sorted by name, stable across syncs) is materialized into
 * the slot at its index, giving operators a real Paperclip agent row at
 * /DEM/agents with `adapterType: openclaw_gateway`.
 *
 * Paperclip's SDK requires managed agents to be statically declared in the
 * manifest, so this cap is a manifest-time choice. Bump it (and rebuild the
 * plugin) if your OpenClaw setup has more than 8 agents.
 */
export const OPENCLAW_AGENT_SLOT_COUNT = 8;
export const OPENCLAW_AGENT_SLOT_PREFIX = "openclaw-slot-";
export const OPENCLAW_ADAPTER_TYPE = "openclaw_gateway";

export function openclawSlotKey(index: number): string {
  return `${OPENCLAW_AGENT_SLOT_PREFIX}${index + 1}`;
}

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Paperclip ↔ OpenClaw Bridge",
  description:
    "Bidirectional sync between Paperclip and an OpenClaw Gateway. Discover OpenClaw agents, surface ambient events into Paperclip tasks, and stream Paperclip activity back to OpenClaw.",
  author: "Adapter Builder Project",
  categories: ["automation", "ui"],
  capabilities: [
    // Plugin state
    "plugin.state.read",
    "plugin.state.write",
    // Runtime/integration
    "events.subscribe",
    "jobs.schedule",
    // Reads
    "companies.read",
    "agents.read",
    "issues.read",
    // Writes
    "issue.comments.create",
    "agents.managed",
    // Tools + UI
    "agent.tools.register",
    "instance.settings.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    required: ["openclawUrl", "syncDirection", "conflictPolicy"],
    properties: {
      openclawUrl: {
        type: "string",
        title: "OpenClaw Gateway URL",
        description: "WebSocket endpoint, e.g. ws://127.0.0.1:18789",
        pattern: "^wss?://",
        default: "ws://127.0.0.1:18789",
      },
      openclawToken: {
        type: "string",
        title: "Gateway Token",
        description:
          "Paste the OpenClaw gateway token here. Find it via `openclaw config get gateway.auth.token`.",
        default: "",
      },
      companyId: {
        type: ["string", "null"],
        title: "Paperclip Company ID",
        description: "Which Paperclip company this bridge syncs into. Choose during the wizard.",
        default: null,
      },
      syncDirection: {
        type: "string",
        title: "Sync direction",
        enum: ["bidirectional", "openclaw-to-paperclip", "paperclip-to-openclaw"],
        default: "bidirectional",
      },
      conflictPolicy: {
        type: "string",
        title: "Conflict policy",
        enum: ["newest-wins", "paperclip-wins", "openclaw-wins", "manual"],
        default: "newest-wins",
      },
      autoSyncCron: {
        type: "string",
        title: "Auto-sync cron",
        default: "*/5 * * * *",
      },
      healthCheckCron: {
        type: "string",
        title: "Health-check cron",
        default: "*/1 * * * *",
      },
      paperclipApiUrl: {
        type: "string",
        title: "Paperclip API URL",
        description:
          "Loopback URL for the local Paperclip API. The bridge PATCHes managed-agent rows here.",
        default: "http://127.0.0.1:3100",
        pattern: "^https?://",
      },
    },
  },
  jobs: [
    {
      jobKey: SYNC_JOB_KEY,
      displayName: "OpenClaw agent sync",
      description: "Diff OpenClaw and Paperclip agent rosters, update the sync snapshot, and reconcile drift.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: HEALTH_JOB_KEY,
      displayName: "OpenClaw health check",
      description: "Probe the OpenClaw Gateway for connectivity and persist the result for the status widget.",
      schedule: "*/1 * * * *",
    },
  ],
  tools: [
    {
      name: TOOL_LIST_CHANNELS,
      displayName: "List OpenClaw channels",
      description: "Return the live channels configured on the connected OpenClaw gateway.",
      parametersSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SETTINGS_PAGE_SLOT_ID,
        displayName: "OpenClaw Bridge",
        exportName: SETTINGS_PAGE_EXPORT,
      },
      {
        type: "dashboardWidget",
        id: STATUS_WIDGET_SLOT_ID,
        displayName: "OpenClaw status",
        exportName: STATUS_WIDGET_EXPORT,
      },
    ],
  },
  // Static slots for materializing OpenClaw agents as Paperclip agents.
  // Sync assigns each discovered OpenClaw agent to a slot deterministically
  // (sorted by name), then the host materializes a Paperclip agent row at
  // /<companyPrefix>/agents using `openclaw_gateway` as the adapter type.
  agents: Array.from({ length: OPENCLAW_AGENT_SLOT_COUNT }, (_, i) => ({
    agentKey: openclawSlotKey(i),
    displayName: `OpenClaw Agent ${i + 1}`,
    title: "OpenClaw bridge agent",
    role: "general",
    adapterType: OPENCLAW_ADAPTER_TYPE,
    capabilities: "Bridged from an OpenClaw gateway by the paperclip-openclaw-bridge plugin.",
    status: "paused" as const,
  })),
};

export default manifest;
