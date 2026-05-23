import { describe, expect, it } from "vitest";
import { StateKeys } from "../src/state-keys.js";
import { DEFAULT_CONFIG } from "../src/types.js";

describe("M1 smoke", () => {
  it("emits instance-scoped config key under openclaw-bridge namespace", () => {
    expect(StateKeys.config).toEqual({
      scopeKind: "instance",
      namespace: "openclaw-bridge",
      stateKey: "config",
    });
  });

  it("emits company-scoped lastSyncAt with the company id baked in", () => {
    expect(StateKeys.lastSyncAt("c_42")).toEqual({
      scopeKind: "company",
      scopeId: "c_42",
      namespace: "openclaw-bridge",
      stateKey: "last-sync-at",
    });
  });

  it("default config uses bidirectional + newest-wins", () => {
    expect(DEFAULT_CONFIG.syncDirection).toBe("bidirectional");
    expect(DEFAULT_CONFIG.conflictPolicy).toBe("newest-wins");
    expect(DEFAULT_CONFIG.openclawToken).toBe("");
  });
});
