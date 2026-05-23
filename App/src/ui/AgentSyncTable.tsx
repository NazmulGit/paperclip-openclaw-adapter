import React from "react";
import type { AgentRowState, SyncStatusSnapshot } from "../types.js";

const TONE: Record<AgentRowState, string> = {
  synced:
    "bg-green-500/15 text-green-700 dark:text-green-400 ring-1 ring-inset ring-green-500/30",
  drift:
    "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30",
  "openclaw-only":
    "bg-blue-500/15 text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30",
  "paperclip-only":
    "bg-violet-500/15 text-violet-700 dark:text-violet-400 ring-1 ring-inset ring-violet-500/30",
};

const LABEL: Record<AgentRowState, string> = {
  synced: "Synced",
  drift: "Drift",
  "openclaw-only": "OpenClaw only",
  "paperclip-only": "Paperclip only",
};

export function AgentSyncTable(props: {
  snapshot: SyncStatusSnapshot;
}): React.ReactElement {
  const rows = props.snapshot.rows;
  if (rows.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No agents synced yet — bind this company and click <span className="font-medium">Sync this company</span> to populate.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left">
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              OpenClaw agent
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Paperclip agent
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              State
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Role
            </th>
            <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Reconciled
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const ocName = row.openclaw?.name ?? null;
            const pcName = row.paperclip?.name ?? null;
            return (
              <tr key={row.name} className="hover:bg-accent/30">
                <td className="px-3 py-2.5">
                  {ocName ? (
                    <span className="font-medium text-foreground">{ocName}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {pcName ? (
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">{pcName}</span>
                      {row.slotKey ? (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          {row.slotKey}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
                      TONE[row.state]
                    }
                  >
                    {LABEL[row.state]}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {row.openclaw?.role ?? row.paperclip?.role ?? "—"}
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">
                  {row.lastReconciledAt
                    ? new Date(row.lastReconciledAt).toLocaleString()
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
