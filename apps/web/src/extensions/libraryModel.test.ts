import { connectorPackageName, featuredConnectors } from "@octant/domain";
import { describe, expect, it } from "vitest";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  ALL_PROVIDERS,
  buildLibrary,
  featuredItems,
  filterLibrary,
  groupLibrary,
  type LibraryFilter,
} from "./libraryModel";

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
  it("keeps Paper separate from hosted connectors and distinguishes installed from usable", () => {
    const available = buildLibrary({ snapshot: undefined, connectors: [] }).find(
      (item) => item.localSetupId === "paper",
    );
    expect(available).toMatchObject({
      kind: "mcp-server",
      source: "Local Paper setup",
      stateLabel: "Not added",
    });
    expect(available?.stateNote).toContain("availability has not been checked");
    const installed = pkg(
      "local-paper",
      { installed: true, trusted: true, pluginDesired: true },
      { addedInSettings: true, slug: "local-paper", localSetupId: "paper" },
      ["mcp"],
      "effective",
    );
    const snapshot = {
      packages: [installed],
      skills: [],
      collisions: [],
      sequence: 0,
      snapshotAt: "2026-11-02T12:00:00.000Z",
    } as unknown as ExtensionSnapshot;
    const paper = buildLibrary({ snapshot, connectors: [] }).filter(
      (item) => item.localSetupId === "paper",
    );
    expect(paper).toHaveLength(1);
    expect(paper[0]?.stateLabel).toBe("Installed · on");
    expect(paper[0]?.connectorId).toBeUndefined();
    expect(paper[0]?.stateNote).toContain("connection not checked");
    const impersonator = { ...installed, addedInSettings: false };
    expect(
      buildLibrary({
        snapshot: { ...snapshot, packages: [impersonator] } as unknown as ExtensionSnapshot,
        connectors: [],
      }).filter((item) => item.localSetupId === "paper"),
    ).toHaveLength(1);
    expect(
      buildLibrary({
        snapshot: { ...snapshot, packages: [impersonator] } as unknown as ExtensionSnapshot,
        connectors: [],
      }).find((item) => item.localSetupId === "paper")?.state,
    ).toBe("available");
  });

  it("keeps Paper trust and policy failures separate from Desktop or document availability", () => {
    for (const [activation, expected] of [
      [{ trusted: false, pluginDesired: true }, "needs-trust"],
      [{ trusted: true, pluginDesired: false }, "off"],
      [{ trusted: true, pluginDesired: true }, "blocked"],
    ] as const) {
      const installed = pkg("local-paper", activation, {
        addedInSettings: true,
        localSetupId: "paper",
      });
      const paper = buildLibrary({ snapshot: snapshot(installed), connectors: [] }).find(
        (item) => item.localSetupId === "paper",
      );
      expect(paper?.state).toBe(expected);
      expect(paper?.stateNote).not.toContain("Desktop is closed");
      expect(paper?.stateNote).not.toContain("No file is open");
    }
  });

  it("lists the bundled connectors with no snapshot and fetches nothing", () => {
    const items = buildLibrary({ snapshot: undefined });
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((item) => item.state === "available")).toBe(true);
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
      ["Paper", "Every provider", "available"],
      ["files", "Claude Code", "available"],
      ["Review", "Codex", "available"],
    ]);
    expect(items.find((item) => item.name === "files")?.providerLogo).toBe("claude");
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
    expect(names("claude")).toEqual(["duo", "Paper"]);
    expect(names("codex")).toEqual(["duo", "Paper"]);
    expect(names("gemini")).toEqual(["solo", "Paper"]);
  });

  it("does not promise that every tool call asks, since remembered approvals cover some", () => {
    const text = JSON.stringify(buildLibrary({ snapshot: snapshot(pkg("a", {})) }));
    expect(text).not.toMatch(/every (tool )?call still asks/);
    expect(text).toContain("approval policy");
  });
});

describe("the library's lead row and groups", () => {
  const all: LibraryFilter = { query: "", kind: "all", state: "all", provider: ALL_PROVIDERS };

  it("leads with the hand-picked connectors that are not connected, in the order picked", () => {
    const items = filterLibrary(buildLibrary({ snapshot: undefined }), all);
    const lead = featuredItems(items, all).map((item) => item.connectorId);
    expect(lead[0]).toBe("github");
    expect(lead).toContain("doop");
    expect(lead).toContain("context7");
  });

  it("drops the lead row while a person searches or narrows to another kind", () => {
    const items = buildLibrary({ snapshot: undefined });
    expect(featuredItems(items, { ...all, query: "doop" })).toEqual([]);
    expect(featuredItems(items, { ...all, kind: "plugin" })).toEqual([]);
    expect(featuredItems(items, { ...all, state: "installed" })).toEqual([]);
  });

  it("groups what is left by the catalog's own categories and shows nothing twice", () => {
    const shown = filterLibrary(buildLibrary({ snapshot: undefined }), all);
    const groups = groupLibrary(shown, all);
    expect(groups.map((group) => group.title)).toEqual([
      "Popular",
      "Developer tools",
      "Business",
      "On this computer",
    ]);
    const lead = new Set(featuredItems(shown, all).map((item) => item.id));
    for (const group of groups) {
      for (const item of group.items) expect(lead.has(item.id)).toBe(false);
    }
  });

  it("keeps the featured set fixed when one is connected, showing its state and keeping it under Installed", () => {
    const featuredCount = featuredConnectors().length;
    const connected = pkg(
      "ext-gh",
      { trusted: true, pluginDesired: true },
      { addedInSettings: true, slug: connectorPackageName("github") },
      ["mcp"],
      "effective",
    );
    const shown = filterLibrary(buildLibrary({ snapshot: snapshot(connected) }), all);
    const lead = featuredItems(shown, all);
    expect(lead).toHaveLength(featuredCount);
    expect(lead.map((item) => item.connectorId)[0]).toBe("github");
    expect(lead[0]).toMatchObject({ state: "on", stateLabel: "On" });
    const groups = groupLibrary(shown, all);
    expect(groups[0]?.title).toBe("Installed");
    expect(groups[0]?.items.map((item) => item.connectorId)).toEqual(["github"]);
    // Narrowing to not-installed shows only the featured ones that are not connected.
    const available = { ...all, state: "available" } as const;
    const left = featuredItems(
      filterLibrary(buildLibrary({ snapshot: snapshot(connected) }), available),
      available,
    );
    expect(left).toHaveLength(featuredCount - 1);
  });

  it("makes a search one flat list of results", () => {
    const filter = { ...all, query: "linear" };
    const groups = groupLibrary(
      filterLibrary(buildLibrary({ snapshot: undefined }), filter),
      filter,
    );
    expect(groups.map((group) => group.title)).toEqual(["Results"]);
  });
});

describe("a skill's card line", () => {
  const skillRecord = (name: string, description?: string, instructions?: string) => ({
    skill: { qualifiedId: `agents-skills-directory:${name}:sha256:x` },
    source: { kind: "agents-skills-directory" },
    displayName: name,
    ...(description === undefined ? {} : { description }),
    ...(instructions === undefined ? {} : { instructions }),
    reviewed: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
  });

  it("uses the skill's own description and leaves the line out when the host gives none", () => {
    const items = buildLibrary({
      snapshot: {
        sequence: 1,
        snapshotAt: "2026-11-02T00:00:00.000Z",
        collisions: [],
        packages: [],
        skills: [
          skillRecord("with-text", "Reviews diffs."),
          skillRecord(
            "found",
            undefined,
            '---\nname: found\ndescription: "Plans a release."\n---\nBody',
          ),
          skillRecord("bare", undefined, "---\nname: bare\n---\nBody"),
        ],
      } as never as ExtensionSnapshot,
      connectors: [],
    });
    expect(items.find((item) => item.name === "with-text")?.summary).toBe("Reviews diffs.");
    expect(items.find((item) => item.name === "found")?.summary).toBe("Plans a release.");
    const bare = items.find((item) => item.name === "bare");
    expect(bare).toBeDefined();
    expect(bare && "summary" in bare).toBe(false);
    expect(JSON.stringify(items)).not.toContain("written skill");
  });
});
