import { describe, expect, it } from "vitest";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { buildLibrary, filterLibrary, ALL_PROVIDERS } from "./libraryModel";

const base = {
  installed: true,
  trusted: false,
  pluginDesired: false,
  componentDesired: false,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};

function pkg(
  id: string,
  activation: Partial<typeof base>,
  extra: Record<string, unknown> = {},
  capabilities: ReadonlyArray<string> = ["mcp"],
  effective: "effective" | "blocked" = "blocked",
) {
  return {
    extensionId: id,
    packageId: `p-${id}`,
    slug: id,
    displayName: id,
    stateVersion: 2,
    version: "1.0.0",
    digest: "sha256:x",
    source: { kind: "catalog", catalogId: "octant", entryId: id },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    activation: { ...base, ...activation },
    components: [
      {
        component: {
          id: "c",
          kind: "mcp-server",
          displayName: "Server",
          declaredCapabilities: capabilities,
        },
        activation: { ...base, ...activation },
        effectiveState:
          effective === "effective"
            ? { kind: "effective" }
            : { kind: "blocked", reason: "untrusted" },
      },
    ],
    diagnostics: [],
    ...extra,
  };
}

function snapshot(...packages: ReadonlyArray<unknown>): ExtensionSnapshot {
  return { sequence: 1, snapshotAt: "2026-11-02T00:00:00.000Z", packages, collisions: [] } as never;
}

describe("the library model", () => {
  it("lists the bundled connectors with no snapshot and fetches nothing", () => {
    const items = buildLibrary({ snapshot: undefined });
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((item) => item.kind === "connector" && item.state === "available")).toBe(
      true,
    );
    expect(items.find((item) => item.name === "Linear")?.address).toBe(
      "https://mcp.linear.app/mcp",
    );
  });

  it("walks an installed package from needs trust to off to on", () => {
    const [needsTrust] = buildLibrary({ snapshot: snapshot(pkg("a", {})), connectors: [] });
    expect(needsTrust).toMatchObject({
      state: "needs-trust",
      steps: { install: "done", trust: "next", enable: "todo" },
    });
    const [off] = buildLibrary({ snapshot: snapshot(pkg("a", { trusted: true })), connectors: [] });
    expect(off).toMatchObject({ state: "off", steps: { trust: "done", enable: "next" } });
    const [on] = buildLibrary({
      snapshot: snapshot(
        pkg(
          "a",
          { trusted: true, pluginDesired: true, componentDesired: true },
          {},
          ["mcp"],
          "effective",
        ),
      ),
      connectors: [],
    });
    expect(on).toMatchObject({ state: "on", steps: { enable: "done" } });
  });

  it("says a desired, trusted package that the host blocks is blocked, with the reason", () => {
    const [item] = buildLibrary({
      snapshot: snapshot(pkg("a", { trusted: true, pluginDesired: true })),
      connectors: [],
    });
    expect(item?.state).toBe("blocked");
    expect(item?.stateNote).toContain("untrusted");
  });

  it("ranks authority by the most severe declared capability", () => {
    const [shell] = buildLibrary({
      snapshot: snapshot(pkg("a", {}, {}, ["instructions", "shell"])),
      connectors: [],
    });
    expect(shell?.authority.level).toBe("high");
    expect(shell?.authority.lines[0]).toContain("commands");
    const [text] = buildLibrary({
      snapshot: snapshot(pkg("b", {}, {}, ["instructions"])),
      connectors: [],
    });
    expect(text?.authority.level).toBe("low");
  });

  it("shows a connected connector once, as the installed package, and hides its catalog card", () => {
    const items = buildLibrary({
      snapshot: snapshot(
        pkg(
          "x",
          { trusted: true, pluginDesired: true, componentDesired: true },
          { slug: "connector-linear", addedInSettings: true },
          ["mcp"],
          "effective",
        ),
      ),
    });
    const linear = items.filter((item) => item.connectorId === "linear");
    expect(linear).toHaveLength(1);
    expect(linear[0]).toMatchObject({ kind: "connector", state: "on", source: "Connector" });
  });

  it("filters by words, kind and state, and puts items needing a decision first", () => {
    const items = buildLibrary({
      snapshot: snapshot(pkg("alpha", { trusted: true }), pkg("beta", {})),
    });
    const attention = filterLibrary(items, {
      query: "",
      kind: "all",
      state: "attention",
      provider: ALL_PROVIDERS,
    });
    expect(attention.map((item) => item.name)).toEqual(["beta"]);
    const installed = filterLibrary(items, {
      query: "",
      kind: "all",
      state: "installed",
      provider: ALL_PROVIDERS,
    });
    expect(installed.map((item) => item.name)).toEqual(["beta", "alpha"]);
    const postgres = filterLibrary(items, {
      query: "POSTGRES",
      kind: "connector",
      state: "all",
      provider: ALL_PROVIDERS,
    });
    expect(postgres.length).toBeGreaterThan(0);
    expect(postgres.every((item) => item.kind === "connector")).toBe(true);
  });

  it("offers what was found in Claude Code and Codex as not yet installed here", () => {
    const items = buildLibrary({
      snapshot: snapshot(),
      connectors: [],
      discovered: {
        servers: [
          {
            id: "s1",
            origin: "claude-code",
            scope: "user",
            name: "files",
            transport: "stdio",
            summary: "npx files",
            needsValues: [],
            unsupportedPlaceholders: [],
            secretNames: [],
          },
        ],
        plugins: [
          {
            id: "p1",
            origin: "codex",
            name: "Review",
            format: "codex-plugin",
            enabledThere: false,
          },
        ],
        notes: [],
      },
    });
    expect(items.map((item) => [item.name, item.provider, item.state])).toEqual([
      ["files", "Claude Code", "available"],
      ["Review", "Codex", "available"],
    ]);
    expect(items[0]?.providerLogo).toBe("claude");
  });

  it("keeps every provider a package declares, labels it with all of them, and finds it under each", () => {
    const two = pkg(
      "duo",
      { trusted: true },
      {
        compatibility: {
          platforms: ["macos"],
          modes: ["code"],
          providerFamilies: ["claude", "codex"],
        },
      },
    );
    const only = pkg(
      "solo",
      { trusted: true },
      { compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: ["gemini"] } },
    );
    const items = buildLibrary({ snapshot: snapshot(two, only), connectors: [] });
    expect(items.find((item) => item.name === "duo")).toMatchObject({
      provider: "claude, codex",
      providers: ["claude", "codex"],
    });
    const names = (provider: string) =>
      filterLibrary(items, { query: "", kind: "all", state: "all", provider }).map(
        (item) => item.name,
      );
    expect(names("claude")).toEqual(["duo"]);
    expect(names("codex")).toEqual(["duo"]);
    expect(names("gemini")).toEqual(["solo"]);
  });

  it("does not promise that every tool call asks, since remembered approvals cover some", () => {
    const text = JSON.stringify(buildLibrary({ snapshot: snapshot(pkg("a", {})) }));
    expect(text).not.toMatch(/every (tool )?call still asks/);
    expect(text).toContain("approval policy");
  });
});
