import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { normalizeConfig, tryResolveSecret, validateConfigStructure } from "../src/config.js";

describe("normalizeConfig", () => {
  it("returns full defaults from empty input", () => {
    const cfg = normalizeConfig({});
    expect(cfg.openclawUrl).toBe("ws://127.0.0.1:18789");
    expect(cfg.syncDirection).toBe("bidirectional");
    expect(cfg.conflictPolicy).toBe("newest-wins");
  });

  it("preserves valid overrides", () => {
    const cfg = normalizeConfig({
      openclawUrl: "wss://prod.example.com:18789",
      openclawToken: "MY_TOKEN",
      companyId: "c_42",
      syncDirection: "openclaw-to-paperclip",
      conflictPolicy: "paperclip-wins",
    });
    expect(cfg.openclawUrl).toBe("wss://prod.example.com:18789");
    expect(cfg.openclawToken).toBe("MY_TOKEN");
    expect(cfg.companyId).toBe("c_42");
    expect(cfg.syncDirection).toBe("openclaw-to-paperclip");
    expect(cfg.conflictPolicy).toBe("paperclip-wins");
  });

  it("discards invalid syncDirection / conflictPolicy", () => {
    const cfg = normalizeConfig({ syncDirection: "nope", conflictPolicy: "lol" });
    expect(cfg.syncDirection).toBe("bidirectional");
    expect(cfg.conflictPolicy).toBe("newest-wins");
  });
});

describe("validateConfigStructure", () => {
  it("accepts a normal bidirectional config", () => {
    const issues = validateConfigStructure(
      normalizeConfig({ companyId: "c1", openclawToken: "0123456789abcdef-token" }),
    );
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("errors on non-ws URL", () => {
    const issues = validateConfigStructure(normalizeConfig({ openclawUrl: "http://x" }));
    expect(issues.some((i) => i.level === "error" && i.field === "openclawUrl")).toBe(true);
  });

  it("warns when companyId is missing", () => {
    const issues = validateConfigStructure(normalizeConfig({}));
    expect(issues.some((i) => i.field === "companyId" && i.level === "warn")).toBe(true);
  });
});

describe("tryResolveSecret", () => {
  it("returns ok:true for a 16+ char value", async () => {
    const ctx = {
      secrets: { resolve: vi.fn(async () => "abcdefghijklmnop") },
    } as unknown as PluginContext;
    expect(await tryResolveSecret(ctx, "X")).toEqual({ ok: true, value: "abcdefghijklmnop" });
  });

  it("returns ok:false for short secrets", async () => {
    const ctx = { secrets: { resolve: vi.fn(async () => "short") } } as unknown as PluginContext;
    const r = await tryResolveSecret(ctx, "X");
    expect(r.ok).toBe(false);
  });

  it("returns ok:false when resolve throws", async () => {
    const ctx = {
      secrets: {
        resolve: vi.fn(async () => {
          throw new Error("missing");
        }),
      },
    } as unknown as PluginContext;
    const r = await tryResolveSecret(ctx, "X");
    expect(r).toEqual({ ok: false, error: "missing" });
  });
});
