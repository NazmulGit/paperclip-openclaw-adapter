import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, type BridgeConfig } from "./types.js";

const ALLOWED_DIRECTIONS = new Set([
  "bidirectional",
  "openclaw-to-paperclip",
  "paperclip-to-openclaw",
]);
const ALLOWED_POLICIES = new Set([
  "newest-wins",
  "paperclip-wins",
  "openclaw-wins",
  "manual",
]);

/**
 * Coerce an unknown blob into a fully-defaulted BridgeConfig.
 * Pure — no IO; safe to call from validators.
 */
export function normalizeConfig(raw: unknown): BridgeConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    openclawUrl: typeof obj.openclawUrl === "string" && obj.openclawUrl.length > 0
      ? obj.openclawUrl
      : DEFAULT_CONFIG.openclawUrl,
    openclawToken: typeof obj.openclawToken === "string"
      ? obj.openclawToken
      : DEFAULT_CONFIG.openclawToken,
    companyId: typeof obj.companyId === "string" && obj.companyId.length > 0 ? obj.companyId : null,
    syncDirection: ALLOWED_DIRECTIONS.has(obj.syncDirection as string)
      ? (obj.syncDirection as BridgeConfig["syncDirection"])
      : DEFAULT_CONFIG.syncDirection,
    conflictPolicy: ALLOWED_POLICIES.has(obj.conflictPolicy as string)
      ? (obj.conflictPolicy as BridgeConfig["conflictPolicy"])
      : DEFAULT_CONFIG.conflictPolicy,
    autoSyncCron: typeof obj.autoSyncCron === "string" && obj.autoSyncCron.length > 0
      ? obj.autoSyncCron
      : DEFAULT_CONFIG.autoSyncCron,
    healthCheckCron: typeof obj.healthCheckCron === "string" && obj.healthCheckCron.length > 0
      ? obj.healthCheckCron
      : DEFAULT_CONFIG.healthCheckCron,
    paperclipApiUrl:
      typeof obj.paperclipApiUrl === "string" && /^https?:\/\//.test(obj.paperclipApiUrl)
        ? obj.paperclipApiUrl
        : DEFAULT_CONFIG.paperclipApiUrl,
  };
}

export interface ConfigValidationIssue {
  field: string;
  message: string;
  level: "warn" | "error";
}

/**
 * Pure structural validation. Use `validateConfigWithResolvers` if you also
 * want to validate the secret and a live OpenClaw probe.
 */
export function validateConfigStructure(cfg: BridgeConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (!/^wss?:\/\//.test(cfg.openclawUrl)) {
    issues.push({ field: "openclawUrl", level: "error", message: "must start with ws:// or wss://" });
  }
  if (!cfg.openclawToken || cfg.openclawToken.length < 16) {
    issues.push({
      field: "openclawToken",
      level: "error",
      message: "gateway token is required (min 16 chars). Get it from `openclaw config get gateway.auth.token`.",
    });
  }
  if (!cfg.companyId) {
    issues.push({
      field: "companyId",
      level: "warn",
      message: "company is not selected yet — sync will refuse to run until set",
    });
  }
  for (const field of ["autoSyncCron", "healthCheckCron"] as const) {
    if (!/^[\d\*\/,\s\-]+$/.test(cfg[field])) {
      issues.push({ field, level: "warn", message: "does not look like a valid cron expression" });
    }
  }
  return issues;
}

export async function loadConfig(ctx: PluginContext): Promise<BridgeConfig> {
  const raw = await ctx.config.get();
  return normalizeConfig(raw);
}

export async function tryResolveSecret(
  ctx: PluginContext,
  ref: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const value = await ctx.secrets.resolve(ref);
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, error: `secret "${ref}" resolved to empty value` };
    }
    if (value.length < 16) {
      return { ok: false, error: `secret "${ref}" is shorter than the 16-char minimum` };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
