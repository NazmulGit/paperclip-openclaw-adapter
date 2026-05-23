import React, { useCallback, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { ACTION_RUN_SYNC, DATA_SYNC_STATUS } from "../manifest.js";
import type { SyncStatusSnapshot } from "../types.js";

export function StatusWidget({ context }: PluginWidgetProps): React.ReactElement {
  const status = usePluginData<SyncStatusSnapshot>(DATA_SYNC_STATUS, {
    companyId: context.companyId,
  });
  const runSync = usePluginAction(ACTION_RUN_SYNC);
  const [busy, setBusy] = useState(false);

  const onSync = useCallback(async () => {
    setBusy(true);
    try {
      await runSync({});
      status.refresh();
    } finally {
      setBusy(false);
    }
  }, [runSync, status]);

  const data = status.data;
  const rows = data?.rows ?? [];
  const driftCount = rows.filter((r) => r.state === "drift").length;
  const onlyOcCount = rows.filter((r) => r.state === "openclaw-only").length;
  const onlyPcCount = rows.filter((r) => r.state === "paperclip-only").length;
  const syncedCount = rows.filter((r) => r.state === "synced").length;

  return (
    <div
      style={{
        padding: 12,
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        background: "#fff",
        fontFamily: "system-ui, sans-serif",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong style={{ fontSize: 13 }}>OpenClaw sync</strong>
        <span
          style={{
            fontSize: 11,
            padding: "2px 6px",
            borderRadius: 4,
            background: data?.openclawHealthy ? "#dcfce7" : "#fee2e2",
            color: data?.openclawHealthy ? "#166534" : "#991b1b",
          }}
        >
          {data?.openclawHealthy ? "live" : "offline"}
        </span>
      </div>

      {status.loading && <div style={{ fontSize: 12 }}>Loading…</div>}
      {!status.loading && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, fontSize: 12 }}>
          <Stat label="Synced" value={syncedCount} />
          <Stat label="OC-only" value={onlyOcCount} />
          <Stat label="PC-only" value={onlyPcCount} />
          <Stat label="Drift" value={driftCount} tone={driftCount > 0 ? "warn" : "ok"} />
        </div>
      )}

      <div style={{ fontSize: 11, color: "#6b7280" }}>
        Last sync: {data?.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : "never"}
        {data?.lastError ? ` • ${data.lastError.message}` : ""}
      </div>

      <button
        onClick={onSync}
        disabled={busy}
        style={{
          alignSelf: "flex-start",
          border: "1px solid #d1d5db",
          background: "#f9fafb",
          borderRadius: 4,
          padding: "4px 8px",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}

function Stat(props: { label: string; value: number; tone?: "ok" | "warn" }): React.ReactElement {
  return (
    <div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: props.tone === "warn" ? "#b45309" : "#111",
        }}
      >
        {props.value}
      </div>
      <div style={{ fontSize: 11, color: "#6b7280" }}>{props.label}</div>
    </div>
  );
}
