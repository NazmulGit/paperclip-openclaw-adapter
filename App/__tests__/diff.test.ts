import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/plugin-sdk";
import { diffAgents } from "../src/sync/diff.js";

function pcAgent(overrides: Partial<Agent> & { name: string }): Agent {
  return {
    id: overrides.id ?? `agt_${overrides.name}`,
    name: overrides.name,
    role: overrides.role ?? "general",
    adapterType: overrides.adapterType ?? "openclaw_gateway",
    // The rest of the Agent shape is irrelevant to diff; cast through unknown.
  } as unknown as Agent;
}

describe("diffAgents", () => {
  it("classifies disjoint rosters", () => {
    const rows = diffAgents({
      openclawAgents: [{ name: "scout" }],
      paperclipAgents: [pcAgent({ name: "hedger" })],
    });
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ["hedger", "paperclip-only"],
      ["scout", "openclaw-only"],
    ]);
  });

  it("flags drift when roles differ", () => {
    const rows = diffAgents({
      openclawAgents: [{ name: "scout", role: "researcher" }],
      paperclipAgents: [pcAgent({ name: "scout", role: "engineer" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("drift");
  });

  it("marks aligned roster rows as synced", () => {
    const rows = diffAgents({
      openclawAgents: [{ name: "ceo", role: "ceo" }],
      paperclipAgents: [pcAgent({ name: "ceo", role: "ceo" })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("synced");
  });

  it("filters paperclip side by adapter type", () => {
    const rows = diffAgents({
      openclawAgents: [],
      paperclipAgents: [
        pcAgent({ name: "internal", adapterType: "claude_local" }),
        pcAgent({ name: "openclawed", adapterType: "openclaw_gateway" }),
      ],
      paperclipAdapterType: "openclaw_gateway",
    });
    expect(rows.map((r) => r.name)).toEqual(["openclawed"]);
  });

  it("is case-insensitive for role match", () => {
    const rows = diffAgents({
      openclawAgents: [{ name: "x", role: "Researcher" }],
      paperclipAgents: [pcAgent({ name: "x", role: "researcher" })],
    });
    expect(rows[0]!.state).toBe("synced");
  });
});
