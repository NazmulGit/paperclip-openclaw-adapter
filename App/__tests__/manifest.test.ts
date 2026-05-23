import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES, PLUGIN_UI_SLOT_TYPES } from "@paperclipai/plugin-sdk";
import manifest, {
  PLUGIN_ID,
  PLUGIN_VERSION,
  SETTINGS_PAGE_SLOT_ID,
  STATUS_WIDGET_SLOT_ID,
  SYNC_JOB_KEY,
  HEALTH_JOB_KEY,
} from "../src/manifest.js";

describe("PaperclipPluginManifestV1 shape", () => {
  it("declares apiVersion 1 + stable id/version", () => {
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(PLUGIN_VERSION);
  });

  it("uses only host-registered capability names", () => {
    const known = new Set(PLUGIN_CAPABILITIES as readonly string[]);
    for (const cap of manifest.capabilities) {
      expect(known.has(cap), `capability ${cap} must exist in PLUGIN_CAPABILITIES`).toBe(true);
    }
  });

  it("declares both jobs with cron schedules", () => {
    const keys = manifest.jobs?.map((j) => j.jobKey) ?? [];
    expect(keys).toContain(SYNC_JOB_KEY);
    expect(keys).toContain(HEALTH_JOB_KEY);
    for (const job of manifest.jobs ?? []) {
      expect(job.schedule).toMatch(/^[\d*\/\s,]+$/);
    }
  });

  it("exposes a settings page + dashboard widget via the UI slots", () => {
    const slots = manifest.ui?.slots ?? [];
    const slotTypes = new Set(slots.map((s) => s.type));
    expect(slotTypes.has("settingsPage")).toBe(true);
    expect(slotTypes.has("dashboardWidget")).toBe(true);

    const ids = slots.map((s) => s.id);
    expect(ids).toContain(SETTINGS_PAGE_SLOT_ID);
    expect(ids).toContain(STATUS_WIDGET_SLOT_ID);

    const allowed = new Set(PLUGIN_UI_SLOT_TYPES as readonly string[]);
    for (const slot of slots) {
      expect(allowed.has(slot.type), `slot type ${slot.type} must be in PLUGIN_UI_SLOT_TYPES`).toBe(true);
    }
  });

  it("publishes an instanceConfigSchema with bidirectional defaults", () => {
    const schema = manifest.instanceConfigSchema as {
      properties: Record<string, { default?: unknown; enum?: string[] }>;
    };
    expect(schema.properties.syncDirection?.default).toBe("bidirectional");
    expect(schema.properties.conflictPolicy?.default).toBe("newest-wins");
    expect(schema.properties.openclawUrl?.default).toBe("ws://127.0.0.1:18789");
    expect(schema.properties.openclawToken?.default).toBe("");
  });
});
