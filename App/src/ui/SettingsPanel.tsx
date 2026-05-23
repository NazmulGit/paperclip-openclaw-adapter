import React, { useCallback, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  ACTION_BOOTSTRAP_TOKEN,
  ACTION_CHAT_HISTORY,
  ACTION_CHAT_SEND,
  ACTION_RUN_SYNC,
  ACTION_SAVE_BULK,
  ACTION_TEST_CONNECTION,
  DATA_ALL_BINDINGS,
  DATA_COMPANIES,
  DATA_GATEWAY_CONFIG,
  DATA_OPENCLAW_AGENTS,
} from "../manifest.js";
import type { CompanyBinding, OpenClawAgentRecord } from "../types.js";

interface CompanySummary {
  id: string;
  name: string;
  issuePrefix: string;
}
interface CompaniesResult {
  companies: CompanySummary[];
  error?: string;
}
interface DiscoveryResult {
  connected: boolean;
  agents: OpenClawAgentRecord[];
  mainKey?: string | null;
  error?: string;
}
interface BindingRow {
  companyId: string;
  companyName: string;
  issuePrefix: string;
  binding: CompanyBinding;
}
interface AllBindingsResult {
  bindings: BindingRow[];
  error?: string;
}
interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  stage?: string;
}

interface GatewayConfigData {
  pluginKey: string;
  openclawUrl: string;
  tokenConfigured: boolean;
  tokenLen: number;
  syncDirection: string;
  conflictPolicy: string;
  autoSyncCron: string;
  healthCheckCron: string;
  error?: string;
}

function StatusPill({
  tone,
  label,
  value,
}: {
  tone: "ok" | "warn" | "neutral";
  label: string;
  value: string;
}): React.ReactElement {
  const toneClasses =
    tone === "ok"
      ? "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30"
      : tone === "warn"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
        : "bg-muted text-muted-foreground border-border";
  const dotClass =
    tone === "ok" ? "bg-green-500" : tone === "warn" ? "bg-amber-500" : "bg-muted-foreground/40";
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium " +
        toneClasses
      }
    >
      <span className={"h-1.5 w-1.5 rounded-full " + dotClass} />
      <span className="text-muted-foreground/80">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

function CollapsibleSection({
  id,
  title,
  open,
  onToggle,
  dot,
  actions,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  dot?: "ok" | "warn" | "neutral";
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const dotClass =
    dot === "ok"
      ? "bg-green-500"
      : dot === "warn"
        ? "bg-amber-500"
        : dot === "neutral"
          ? "bg-muted-foreground/40"
          : null;
  return (
    <section
      id={`section-${id}`}
      className="rounded-xl border border-border bg-card shadow-xs overflow-hidden"
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-accent/30 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <svg
            className={"h-3 w-3 text-muted-foreground transition-transform " + (open ? "rotate-90" : "")}
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M4 2.5l4 3.5-4 3.5z" />
          </svg>
          {dotClass ? <span className={"h-1.5 w-1.5 rounded-full " + dotClass} aria-hidden="true" /> : null}
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        </div>
        {actions ? <div onClick={(e) => e.stopPropagation()}>{actions}</div> : null}
      </button>
      {open ? <div className="border-t border-border px-4 py-4">{children}</div> : null}
    </section>
  );
}

export function SettingsPanel(_props: PluginSettingsPageProps): React.ReactElement {
  // BISECT-STEP-3: hooks + state + callbacks + useMemo, then minimal JSX
  const companies = usePluginData<CompaniesResult>(DATA_COMPANIES, {});
  const discovery = usePluginData<DiscoveryResult>(DATA_OPENCLAW_AGENTS, {});
  const allBindings = usePluginData<AllBindingsResult>(DATA_ALL_BINDINGS, {});
  const gatewayConfig = usePluginData<GatewayConfigData>(DATA_GATEWAY_CONFIG, {});
  const runSync = usePluginAction(ACTION_RUN_SYNC);
  const testConnection = usePluginAction(ACTION_TEST_CONNECTION);
  const saveBulk = usePluginAction(ACTION_SAVE_BULK);
  const bootstrapToken = usePluginAction(ACTION_BOOTSTRAP_TOKEN);
  const chatSend = usePluginAction(ACTION_CHAT_SEND);
  const chatHistory = usePluginAction(ACTION_CHAT_HISTORY);
  const [busy, setBusy] = useState<"test" | "sync" | "save" | "chat" | "bootstrap" | "saveConn" | null>(null);
  const [lastAction, setLastAction] = useState<ActionResult | null>(null);
  const [pickedCompanies, setPickedCompanies] = useState<Set<string>>(new Set());
  const [pickedAgents, setPickedAgents] = useState<Set<string>>(new Set());
  const [chatAgent, setChatAgent] = useState<string>("");
  const [chatMessage, setChatMessage] = useState<string>("What is 2+2?");
  const [chatReply, setChatReply] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [editConn, setEditConn] = useState(false);
  const [connUrl, setConnUrl] = useState("");
  const [connToken, setConnToken] = useState("");
  // Sections start auto-expanded based on completion state; the user can
  // toggle freely after. Keeping the set in a Set lets us add/remove without
  // recomputing the whole object.
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(["connection", "config"]));
  const toggleSection = (id: string) =>
    setOpenSections((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onTest = useCallback(async () => {
    setBusy("test");
    setLastAction(null);
    try {
      const r = (await testConnection({})) as ActionResult;
      setLastAction(r);
      discovery.refresh();
    } catch (err) {
      setLastAction({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [testConnection, discovery]);

  const onSyncAll = useCallback(async () => {
    setBusy("sync");
    setLastAction(null);
    try {
      const r = (await runSync({ syncAll: true })) as ActionResult & {
        companies?: unknown[];
        skipped?: unknown[];
      };
      const c = Array.isArray(r.companies) ? r.companies.length : 0;
      const s = Array.isArray(r.skipped) ? r.skipped.length : 0;
      setLastAction({
        ...r,
        message: r.ok ? `Synced ${c} bound companies (${s} skipped).` : undefined,
      });
      allBindings.refresh();
    } catch (err) {
      setLastAction({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [runSync, allBindings]);

  const onSave = useCallback(async () => {
    setBusy("save");
    setLastAction(null);
    try {
      const r = (await saveBulk({
        companyIds: [...pickedCompanies],
        agentNames: [...pickedAgents],
      })) as ActionResult & { saved?: unknown[]; failures?: unknown[] };
      const okCount = Array.isArray(r.saved) ? r.saved.length : 0;
      setLastAction({
        ...r,
        message: r.ok
          ? `Saved ${pickedAgents.size} agent(s) to ${okCount} company(ies).`
          : `${r.error ?? "save failed"}`,
      });
      allBindings.refresh();
    } catch (err) {
      setLastAction({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [saveBulk, pickedCompanies, pickedAgents, allBindings]);

  // Save gateway URL + token by POSTing to Paperclip's plugin config endpoint.
  // Paperclip's auto-config form is hidden when a custom settingsPage exists,
  // so this UI is the only path to edit these from the browser. PC restarts
  // the worker on config change, which re-bootstraps OpenClawClient with the
  // new URL/token automatically.
  const onSaveConnection = useCallback(async () => {
    setBusy("saveConn");
    setLastAction(null);
    try {
      const pluginKey = gatewayConfig.data?.pluginKey;
      if (!pluginKey) {
        setLastAction({ ok: false, error: "config not yet loaded" });
        return;
      }
      // Resolve plugin instance UUID from pluginKey.
      const allPlugins = (await fetch("/api/plugins").then((r) => r.json())) as Array<{
        id: string;
        pluginKey: string;
      }>;
      const me = allPlugins.find((p) => p.pluginKey === pluginKey);
      if (!me) {
        setLastAction({ ok: false, error: `plugin '${pluginKey}' not installed?` });
        return;
      }
      const next: Record<string, unknown> = {
        openclawUrl: connUrl.trim() || gatewayConfig.data!.openclawUrl,
        syncDirection: gatewayConfig.data!.syncDirection,
        conflictPolicy: gatewayConfig.data!.conflictPolicy,
        autoSyncCron: gatewayConfig.data!.autoSyncCron,
        healthCheckCron: gatewayConfig.data!.healthCheckCron,
      };
      // Only include token if the user actually typed a new value — leaving
      // it blank means "keep existing token", not "wipe it".
      if (connToken.trim().length > 0) {
        next.openclawToken = connToken.trim();
      }
      const res = await fetch(`/api/plugins/${me.id}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configJson: next }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setLastAction({ ok: false, error: `HTTP ${res.status}: ${text.slice(0, 240)}` });
        return;
      }
      setLastAction({
        ok: true,
        message: "Connection saved. Worker restarted with new config.",
      });
      setEditConn(false);
      setConnToken("");
      // Refresh views that depend on the connection.
      gatewayConfig.refresh();
      discovery.refresh();
    } catch (err) {
      setLastAction({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [connUrl, connToken, gatewayConfig, discovery]);

  // Bootstrap mints a per-agent Paperclip API key for every openclaw_gateway
  // agent in every BOUND company, and inlines the key into each agent's
  // adapterConfig.payloadTemplate.message. Without this, OC agents can run
  // but every issue mutation (checkout, comment, status) returns 403
  // because the agent has no Paperclip credentials. After bootstrap the
  // full PC -> OC -> Claude -> PC round-trip works.
  const onBootstrap = useCallback(async () => {
    setBusy("bootstrap");
    setLastAction(null);
    try {
      const bound = (allBindings.data?.bindings ?? []).filter((r) => r.binding.enabled);
      if (bound.length === 0) {
        setLastAction({ ok: false, error: "No bound companies. Save a binding first." });
        return;
      }
      let totalSuccess = 0;
      let totalAgents = 0;
      const failures: string[] = [];
      for (const row of bound) {
        const r = (await bootstrapToken({ companyId: row.companyId })) as {
          ok: boolean;
          successCount?: number;
          totalAgents?: number;
          error?: string;
        };
        if (r.ok) {
          totalSuccess += r.successCount ?? 0;
          totalAgents += r.totalAgents ?? 0;
        } else {
          failures.push(`${row.companyName}: ${r.error ?? "unknown"}`);
        }
      }
      setLastAction(
        failures.length === 0
          ? {
              ok: true,
              message: `Bootstrapped ${totalSuccess}/${totalAgents} agent credentials across ${bound.length} company(ies). PC<->OC round-trip is now wired.`,
            }
          : {
              ok: false,
              error: failures.join("; "),
            },
      );
      allBindings.refresh();
    } catch (err) {
      setLastAction({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, [bootstrapToken, allBindings]);

  const onChat = useCallback(async () => {
    if (!chatAgent || !chatMessage.trim()) return;
    setBusy("chat");
    setChatReply(null);
    setChatError(null);
    try {
      const sendRes = (await chatSend({
        agentName: chatAgent,
        message: chatMessage,
      })) as { ok: boolean; sessionKey?: string; error?: string; stage?: string };
      if (!sendRes.ok || !sendRes.sessionKey) {
        setChatError(
          `${sendRes.stage ? sendRes.stage + ": " : ""}${sendRes.error ?? "send failed"}`,
        );
        return;
      }
      const sessionKey = sendRes.sessionKey;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const histRes = (await chatHistory({ sessionKey })) as {
          ok: boolean;
          messages?: Array<Record<string, unknown>>;
          error?: string;
        };
        if (!histRes.ok) {
          setChatError(histRes.error ?? "history failed");
          return;
        }
        const messages = histRes.messages ?? [];
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        if (last) {
          const c = last.content;
          if (typeof c === "string" && c.trim()) {
            setChatReply(c);
            return;
          }
          if (Array.isArray(c)) {
            const text = c
              .map((p) =>
                typeof p === "string"
                  ? p
                  : p && typeof p === "object" && "text" in p
                    ? String((p as { text: unknown }).text)
                    : "",
              )
              .join("")
              .trim();
            if (text) {
              setChatReply(text);
              return;
            }
          }
        }
      }
      setChatError("No reply within ~24 s. Try again — OpenClaw may still be processing.");
    } catch (err) {
      setChatError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [chatAgent, chatMessage, chatSend, chatHistory]);
  const savedRows = (allBindings.data?.bindings ?? []).filter((r) => r.binding.enabled);
  const savedSorted = useMemo(
    () => [...savedRows].sort((a, b) => a.companyName.localeCompare(b.companyName)),
    [savedRows],
  );
  const connectionOk = discovery.data?.connected === true;
  const tokenOk = gatewayConfig.data?.tokenConfigured === true;
  const bindingsCount = savedRows.length;
  // Bootstrap status is per-company; show "wired" if at least one bound
  // company has been bootstrapped, "missing" if none, "partial" otherwise.
  // We don't fetch per-company state here to keep the panel light — the
  // user clicks Bootstrap explicitly so this is informational only.
  const isConnOpen = openSections.has("connection");
  const isCfgOpen = openSections.has("config");
  const isSavedOpen = openSections.has("saved");
  const isChatOpen = openSections.has("chat");
  return (
    <div className="grid gap-4 max-w-6xl">
      <header className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-foreground">OpenClaw Bridge</h1>
            <p className="text-sm text-muted-foreground">
              Mirror OpenClaw agents into Paperclip companies. Issues assigned to a bridged
              agent are routed through OpenClaw and the agent's reply flows back as comments.
            </p>
          </div>
        </div>
        {/* Status strip — three at-a-glance health pills */}
        <div className="flex flex-wrap gap-2">
          <StatusPill
            tone={connectionOk ? "ok" : "warn"}
            label="Gateway"
            value={connectionOk ? "connected" : "offline"}
          />
          <StatusPill
            tone={tokenOk ? "ok" : "warn"}
            label="Token"
            value={tokenOk ? "set" : "missing"}
          />
          <StatusPill
            tone={bindingsCount > 0 ? "ok" : "neutral"}
            label="Bindings"
            value={`${bindingsCount} active`}
          />
        </div>
      </header>
      <CollapsibleSection
        id="connection"
        title="Connection"
        open={isConnOpen}
        onToggle={() => toggleSection("connection")}
        dot={tokenOk && connectionOk ? "ok" : "warn"}
        actions={
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!editConn) setConnUrl(gatewayConfig.data?.openclawUrl ?? "");
              setEditConn((v) => !v);
              if (!isConnOpen) toggleSection("connection");
            }}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            {editConn ? "Cancel" : "Edit"}
          </button>
        }
      >
        {!editConn ? (
          <div className="grid sm:grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
            <span className="text-muted-foreground">Gateway URL</span>
            <span className="font-mono text-xs break-all">
              {gatewayConfig.data?.openclawUrl ?? "—"}
            </span>
            <span className="text-muted-foreground">Gateway token</span>
            <span className="font-mono text-xs">
              {gatewayConfig.data?.tokenConfigured
                ? `configured (${gatewayConfig.data.tokenLen} chars)`
                : (
                  <span className="text-amber-700 dark:text-amber-400">
                    missing — click Edit to set
                  </span>
                )}
            </span>
            <span className="text-muted-foreground">Sync direction</span>
            <span className="font-mono text-xs">{gatewayConfig.data?.syncDirection ?? "—"}</span>
            <span className="text-muted-foreground">Conflict policy</span>
            <span className="font-mono text-xs">{gatewayConfig.data?.conflictPolicy ?? "—"}</span>
            <span className="text-muted-foreground">Auto-sync</span>
            <span className="font-mono text-xs">{gatewayConfig.data?.autoSyncCron ?? "—"}</span>
            <span className="text-muted-foreground">Health check</span>
            <span className="font-mono text-xs">{gatewayConfig.data?.healthCheckCron ?? "—"}</span>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <div className="text-xs font-medium text-muted-foreground mb-1">Gateway URL</div>
              <input
                type="text"
                value={connUrl}
                onChange={(e) => setConnUrl(e.target.value)}
                placeholder="ws://127.0.0.1:18789"
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
              />
            </label>
            <label className="block">
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Gateway token{" "}
                {gatewayConfig.data?.tokenConfigured ? (
                  <span className="text-[10px] text-muted-foreground">
                    (leave blank to keep existing)
                  </span>
                ) : null}
              </div>
              <input
                type="password"
                value={connToken}
                onChange={(e) => setConnToken(e.target.value)}
                placeholder="openclaw config get gateway.auth.token"
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
              />
            </label>
            <div className="flex gap-2">
              <button
                onClick={onSaveConnection}
                disabled={busy !== null}
                className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
              >
                {busy === "saveConn" ? "Saving…" : "Save connection"}
              </button>
              <button
                onClick={() => {
                  setEditConn(false);
                  setConnToken("");
                }}
                disabled={busy !== null}
                className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent/50"
              >
                Cancel
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paperclip restarts the plugin worker after a config change. Test connection right
              after saving to confirm the new URL + token work.
            </p>
          </div>
        )}
      </CollapsibleSection>
      <section className="rounded-xl border border-border bg-card p-4 shadow-xs">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Sync
          </h2>
          <span className="text-xs text-muted-foreground">
            {savedRows.length} bound company(ies)
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onTest}
            disabled={busy !== null}
            className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium shadow-xs hover:bg-accent/50 disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button
            onClick={onSyncAll}
            disabled={busy !== null}
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy === "sync" ? "Syncing…" : "Sync now (all bindings)"}
          </button>
          <button
            onClick={onBootstrap}
            disabled={busy !== null || savedRows.length === 0}
            title="Mint a per-agent Paperclip API key for every OC-bridged agent and inline it into their wake messages. Required for OC agents to actually post comments / close issues."
            className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium shadow-xs hover:bg-accent/50 disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy === "bootstrap" ? "Bootstrapping…" : "Bootstrap PC credentials"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          <strong>Bootstrap PC credentials</strong> grants each bridged OpenClaw agent a Paperclip API
          key so it can actually act on assigned issues (checkout, comment, close). Run it once after
          saving a binding; rerun anytime to rotate keys.
        </p>
      </section>
      <CollapsibleSection
        id="config"
        title="Configuration"
        open={isCfgOpen}
        onToggle={() => toggleSection("config")}
        dot={bindingsCount > 0 ? "ok" : "warn"}
        actions={
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSave();
            }}
            disabled={busy !== null || pickedCompanies.size === 0 || pickedAgents.size === 0}
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        }
      >
        <p className="text-xs text-muted-foreground mb-3">
          Multi-select on both sides. Save writes the same agent allowlist into every selected
          Paperclip company.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {/* Paperclip companies */}
          <div className="rounded-md border border-border bg-background/50 flex flex-col min-h-[220px]">
            <div className="border-b border-border px-3 py-2 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Paperclip Companies
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {pickedCompanies.size} selected · {(companies.data?.companies ?? []).length} total
                </div>
              </div>
              <button
                onClick={() => {
                  const all = (companies.data?.companies ?? []).map((c) => c.id);
                  setPickedCompanies(
                    pickedCompanies.size === all.length ? new Set() : new Set(all),
                  );
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                {pickedCompanies.size === (companies.data?.companies ?? []).length &&
                (companies.data?.companies ?? []).length > 0
                  ? "Clear all"
                  : "Select all"}
              </button>
            </div>
            <ul className="divide-y divide-border overflow-y-auto max-h-72">
              {(companies.data?.companies ?? []).map((c) => {
                const checked = pickedCompanies.has(c.id);
                return (
                  <li key={c.id}>
                    <label
                      className={
                        "flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-accent/30 " +
                        (checked ? "bg-primary/5" : "")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(pickedCompanies);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          setPickedCompanies(next);
                        }}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{c.name}</div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {c.issuePrefix} · {c.id.slice(0, 8)}…
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          {/* OpenClaw agents */}
          <div className="rounded-md border border-border bg-background/50 flex flex-col min-h-[220px]">
            <div className="border-b border-border px-3 py-2 flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  OpenClaw Agents
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {pickedAgents.size} selected · {(discovery.data?.agents ?? []).length} discovered
                </div>
              </div>
              <button
                onClick={() => {
                  const all = (discovery.data?.agents ?? []).map((a) => a.name);
                  setPickedAgents(pickedAgents.size === all.length ? new Set() : new Set(all));
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                {pickedAgents.size === (discovery.data?.agents ?? []).length &&
                (discovery.data?.agents ?? []).length > 0
                  ? "Clear all"
                  : "Select all"}
              </button>
            </div>
            <ul className="divide-y divide-border overflow-y-auto max-h-72">
              {(discovery.data?.agents ?? []).map((a) => {
                const checked = pickedAgents.has(a.name);
                return (
                  <li key={a.name}>
                    <label
                      className={
                        "flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-accent/30 " +
                        (checked ? "bg-primary/5" : "")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(pickedAgents);
                          if (next.has(a.name)) next.delete(a.name);
                          else next.add(a.name);
                          setPickedAgents(next);
                        }}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{a.name}</div>
                        <div className="text-[10px] font-mono text-muted-foreground truncate">
                          {a.model ?? "—"}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </CollapsibleSection>
      {/* Saved bindings */}
      <CollapsibleSection
        id="saved"
        title="Saved bindings"
        open={isSavedOpen}
        onToggle={() => toggleSection("saved")}
        dot={savedSorted.length > 0 ? "ok" : "neutral"}
        actions={<span className="text-xs text-muted-foreground">{savedSorted.length} active</span>}
      >
        {savedSorted.length > 0 ? (
          <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
            URL, token, session strategy, and timeout are auto-filled by the bridge on sync. For
            per-agent overrides (model, scopes, payload template), open the agent at{" "}
            <code className="font-mono text-[11px]">
              /&lt;prefix&gt;/agents/&lt;name&gt;/dashboard
            </code>
            {" "}— all 12 OpenClaw Gateway fields are available there.
          </p>
        ) : null}
        {savedSorted.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
            <div className="text-sm text-muted-foreground">No bindings yet.</div>
            <div className="text-xs text-muted-foreground mt-1">
              Open <b>Configuration</b> above, pick companies + agents, then <b>Save</b>.
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Paperclip company
                  </th>
                  <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    OpenClaw agents
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {savedSorted.map((row) => (
                  <tr key={row.companyId} className="hover:bg-accent/30">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-foreground">{row.companyName}</div>
                      <div className="text-[10px] font-mono text-muted-foreground">
                        {row.issuePrefix} · {row.companyId.slice(0, 8)}…
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {row.binding.agentNames.length === 0 ? (
                        <span className="inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                          all agents
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {row.binding.agentNames.map((n) => (
                            <span
                              key={n}
                              className="inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground"
                            >
                              {n}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleSection>

      {/* Live chat test — collapsed by default; advanced users open as needed */}
      <CollapsibleSection
        id="chat"
        title="Live chat test"
        open={isChatOpen}
        onToggle={() => toggleSection("chat")}
        dot="neutral"
      >
        <p className="text-xs text-muted-foreground mb-3">
          Send a one-off message to an OpenClaw agent to confirm it&rsquo;s executing.
        </p>
        <div className="grid sm:grid-cols-[200px_1fr_auto] gap-2 items-start">
          <select
            value={chatAgent}
            onChange={(e) => setChatAgent(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">Pick an agent…</option>
            {(discovery.data?.agents ?? []).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={chatMessage}
            onChange={(e) => setChatMessage(e.target.value)}
            placeholder="Type a question…"
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button
            onClick={onChat}
            disabled={busy !== null || !chatAgent || !chatMessage.trim()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy === "chat" ? "Sending…" : "Send"}
          </button>
        </div>
        {chatError ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {chatError}
          </div>
        ) : null}
        {chatReply ? (
          <div className="mt-3 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-foreground">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Reply from {chatAgent}
            </div>
            <div className="whitespace-pre-wrap font-mono text-xs">{chatReply}</div>
          </div>
        ) : null}
      </CollapsibleSection>

      {lastAction ? (
        <div
          role="status"
          className={
            "rounded-md border px-3 py-2 text-sm " +
            (lastAction.ok
              ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
              : "border-destructive/30 bg-destructive/10 text-destructive")
          }
        >
          {lastAction.ok
            ? lastAction.message ?? "OK"
            : `${lastAction.stage ? lastAction.stage + ": " : ""}${lastAction.error ?? lastAction.message ?? ""}`}
        </div>
      ) : null}
    </div>
  );
}
