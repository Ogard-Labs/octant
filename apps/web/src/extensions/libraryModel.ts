import type {
  DiscoveredAgentToolingListing,
  ExtensionCatalogEntry,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import type { ExtensionCapability } from "@octant/contracts/extensions";
import {
  CONNECTOR_CATEGORY_LABEL,
  connectorCatalog,
  connectorPackageName,
  type ConnectorCatalogEntry,
} from "@octant/domain";
import { providerFit } from "./providerFit";

export type LibraryKind = "connector" | "plugin" | "skill" | "mcp-server";

/**
 * Where a person stands with one item. `available` means nothing is installed
 * yet; the others follow the ladder the host enforces: installed, trusted,
 * then on.
 */
export type LibraryState = "available" | "needs-trust" | "off" | "on" | "blocked";

export type StepState = "done" | "next" | "todo";

export interface LibrarySteps {
  readonly install: StepState;
  readonly trust: StepState;
  readonly enable: StepState;
}

export type AuthorityLevel = "none" | "low" | "medium" | "high";

export interface LibraryAuthority {
  readonly level: AuthorityLevel;
  /** One plain line per thing the item may do, most severe first. */
  readonly lines: ReadonlyArray<string>;
}

/** The place an item's own flow lives, when the Library cannot finish it. */
export type LibraryHandoff = "connectors" | "marketplace" | "installed";

export interface LibraryItem {
  readonly id: string;
  readonly kind: LibraryKind;
  readonly name: string;
  readonly summary: string;
  /** Where it comes from, in the words the Installed view uses. */
  readonly source: string;
  /** The provider it is for, or "Every provider". */
  readonly provider: string;
  /** The key of the bundled provider logo when the item belongs to one provider. */
  readonly providerLogo?: string;
  /** A catalog grouping, for items that have one. */
  readonly category?: string;
  readonly featured: boolean;
  readonly state: LibraryState;
  readonly stateLabel: string;
  /** Why it is blocked, when it is. */
  readonly stateNote?: string;
  readonly steps: LibrarySteps;
  readonly abilities: ReadonlyArray<string>;
  readonly authority: LibraryAuthority;
  readonly handoff: LibraryHandoff;
  /** Set for an installed package, so trust and enable can act on it. */
  readonly packageRef?: {
    readonly extensionId: string;
    readonly stateVersion: number;
    readonly trusted: boolean;
    readonly desired: boolean;
  };
  readonly connectorId?: string;
  readonly address?: string;
  readonly version?: string;
}

export interface LibrarySources {
  readonly snapshot: ExtensionSnapshot | undefined;
  /** Entries a person already searched for in Marketplace; never fetched here. */
  readonly marketplace?: ReadonlyArray<ExtensionCatalogEntry>;
  readonly discovered?: DiscoveredAgentToolingListing | undefined;
  readonly connectors?: ReadonlyArray<ConnectorCatalogEntry>;
}

type Capability = ExtensionCapability;

interface CapabilityFact {
  readonly ability: string;
  readonly cost: string;
  readonly level: Exclude<AuthorityLevel, "none">;
}

const CAPABILITY_FACTS: Readonly<Record<Capability, CapabilityFact>> = {
  instructions: {
    ability: "Adds written instructions the agent can follow",
    cost: "Adds text to what the agent reads; it runs nothing",
    level: "low",
  },
  mcp: {
    ability: "Gives the agent tools from a tool server",
    cost: "Starts or reaches a tool server; every call still asks",
    level: "medium",
  },
  filesystem: {
    ability: "Reads or changes files",
    cost: "Touches files inside the folder the thread is allowed to use",
    level: "high",
  },
  shell: {
    ability: "Runs commands",
    cost: "Runs commands on this computer under the thread's mode",
    level: "high",
  },
  network: {
    ability: "Talks to services on the internet",
    cost: "Sends requests out of this computer",
    level: "medium",
  },
  browser: {
    ability: "Drives a browser",
    cost: "Opens and acts on web pages",
    level: "medium",
  },
  "computer-use": {
    ability: "Controls the screen",
    cost: "Clicks and types in apps on this computer",
    level: "high",
  },
  credentials: {
    ability: "Uses a stored key or sign-in",
    cost: "Uses a credential kept in this computer's credential store",
    level: "high",
  },
  "external-application": {
    ability: "Works with another app",
    cost: "Starts or drives an app outside Octant",
    level: "high",
  },
  hooks: {
    ability: "Reacts to events in a thread",
    cost: "Runs its own code when something happens in a thread",
    level: "high",
  },
  apps: {
    ability: "Shows its own panels",
    cost: "Draws interface of its own inside Octant",
    level: "medium",
  },
  agents: {
    ability: "Adds helper agents",
    cost: "Starts agents that run under the same mode",
    level: "medium",
  },
  "apple-development": {
    ability: "Builds and tests Apple apps",
    cost: "Runs Xcode tools and simulators on this computer",
    level: "high",
  },
};

const LEVEL_ORDER: Readonly<Record<AuthorityLevel, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export const LIBRARY_KIND_LABEL: Readonly<Record<LibraryKind, string>> = {
  connector: "Connectors",
  plugin: "Plugins",
  skill: "Skills",
  "mcp-server": "MCP servers",
};

export const LIBRARY_STATE_LABEL: Readonly<Record<LibraryState, string>> = {
  available: "Not installed",
  "needs-trust": "Needs trust",
  off: "Off",
  on: "On",
  blocked: "Blocked",
};

type InstalledPackage = ExtensionSnapshot["packages"][number];
type StandaloneSkill = NonNullable<ExtensionSnapshot["skills"]>[number];

function authorityFor(capabilities: ReadonlyArray<Capability>): LibraryAuthority {
  const facts = [...new Set(capabilities)]
    .map((capability) => CAPABILITY_FACTS[capability])
    .sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
  const first = facts[0];
  if (first === undefined) {
    return { level: "none", lines: ["Declares nothing beyond its description."] };
  }
  return { level: first.level, lines: facts.map((fact) => fact.cost) };
}

function abilitiesFor(capabilities: ReadonlyArray<Capability>): ReadonlyArray<string> {
  return [...new Set(capabilities)].map((capability) => CAPABILITY_FACTS[capability].ability);
}

function stepsFor(installed: boolean, trusted: boolean, on: boolean): LibrarySteps {
  if (!installed) return { install: "next", trust: "todo", enable: "todo" };
  if (!trusted) return { install: "done", trust: "next", enable: "todo" };
  if (!on) return { install: "done", trust: "done", enable: "next" };
  return { install: "done", trust: "done", enable: "done" };
}

function packageSource(source: InstalledPackage["source"]): string {
  switch (source.kind) {
    case "bundled":
      return "Bundled with Octant";
    case "catalog":
      if (source.catalogId === "skills-sh") return "skills.sh";
      if (source.catalogId === "npm") return "npm";
      if (source.catalogId === "npm-agent-plugins") return "npm";
      return "Marketplace";
    case "local-folder":
      return "Local folder";
    case "agents-skills-directory":
      return "Agents skills folder";
    case "plugin-package":
      return "Plugin package";
    case "provider-native":
      return "Provider's own";
    case "user-added":
      return "Added by you";
  }
}

function packageItem(pkg: InstalledPackage, connectors: ReadonlyArray<ConnectorCatalogEntry>) {
  const components = pkg.components.map((entry) => entry.component);
  const capabilities = components.flatMap((component) => component.declaredCapabilities);
  const connector = connectors.find(
    (entry) => pkg.addedInSettings === true && pkg.slug === connectorPackageName(entry.id),
  );
  const server = components.find((component) => component.kind === "mcp-server");
  const kind: LibraryKind =
    connector !== undefined
      ? "connector"
      : pkg.addedInSettings === true || (server !== undefined && components.length === 1)
        ? "mcp-server"
        : "plugin";
  const trusted = pkg.activation.trusted;
  const desired = pkg.activation.pluginDesired;
  const anyEffective = pkg.components.some((entry) => entry.effectiveState.kind === "effective");
  const blocked = desired && trusted && !anyEffective && pkg.components.length > 0;
  let state: LibraryState;
  if (!trusted) state = "needs-trust";
  else if (!desired) state = "off";
  else if (blocked) state = "blocked";
  else state = "on";
  const blockedBy = pkg.components.find((entry) => entry.effectiveState.kind === "blocked");
  const fit = providerFit(pkg);
  const families = pkg.compatibility.providerFamilies;
  const only = families.length === 1 ? String(families[0]) : undefined;
  const name =
    connector?.displayName ??
    (pkg.addedInSettings === true ? server?.displayName : undefined) ??
    pkg.displayName ??
    pkg.slug ??
    String(pkg.extensionId);
  const summary =
    connector?.description ??
    components.find((component) => component.description !== undefined)?.description ??
    fit.sentence;
  const abilities = abilitiesFor(capabilities);
  const item: LibraryItem = {
    id: `package:${pkg.extensionId}`,
    kind,
    name: String(name),
    summary,
    source: connector !== undefined ? "Connector" : packageSource(pkg.source),
    provider: only === undefined ? "Every provider" : only,
    ...(only === undefined ? {} : { providerLogo: only }),
    ...(connector === undefined ? {} : { category: CONNECTOR_CATEGORY_LABEL[connector.category] }),
    featured: connector?.category === "popular",
    state,
    stateLabel: LIBRARY_STATE_LABEL[state],
    ...(state === "blocked" && blockedBy?.effectiveState.kind === "blocked"
      ? { stateNote: `Blocked: ${blockedBy.effectiveState.reason.replaceAll("-", " ")}.` }
      : {}),
    steps: stepsFor(true, trusted, state === "on"),
    abilities: abilities.length === 0 ? [fit.sentence] : abilities,
    authority: authorityFor(capabilities),
    handoff: "installed",
    packageRef: {
      extensionId: String(pkg.extensionId),
      stateVersion: Number(pkg.stateVersion),
      trusted,
      desired,
    },
    version: String(pkg.version),
    ...(connector === undefined ? {} : { connectorId: connector.id, address: connector.url }),
  };
  return item;
}

function skillItem(skill: StandaloneSkill): LibraryItem {
  const on = skill.desiredEnabled && skill.effectiveState.kind === "effective";
  const state: LibraryState = !skill.reviewed
    ? "needs-trust"
    : !skill.desiredEnabled
      ? "off"
      : on
        ? "on"
        : "blocked";
  return {
    id: `skill:${skill.skill.qualifiedId}`,
    kind: "skill",
    name: skill.displayName,
    summary: skill.description ?? "A written skill the agent can follow.",
    source: packageSource(skill.source),
    provider: "Every provider",
    featured: false,
    state,
    stateLabel: LIBRARY_STATE_LABEL[state],
    ...(state === "blocked" && skill.effectiveState.kind === "blocked"
      ? { stateNote: `Blocked: ${skill.effectiveState.reason.replaceAll("-", " ")}.` }
      : {}),
    steps: stepsFor(true, skill.reviewed, on),
    abilities: [CAPABILITY_FACTS.instructions.ability],
    authority: authorityFor(["instructions"]),
    handoff: "installed",
    ...(skill.version === undefined ? {} : { version: String(skill.version) }),
  };
}

function connectorItem(entry: ConnectorCatalogEntry): LibraryItem {
  const host = new URL(entry.url).host;
  const lines = [`Sends your requests to ${host}; every tool call still asks`];
  if (entry.auth.kind === "sign-in")
    lines.push(`Signs in to ${host} and keeps the grant in the credential store`);
  if (entry.auth.kind === "key") lines.push("Uses a key you create, kept in the credential store");
  return {
    id: `connector:${entry.id}`,
    kind: "connector",
    name: entry.displayName,
    summary: entry.description,
    source: "Connector catalog",
    provider: "Every provider",
    category: CONNECTOR_CATEGORY_LABEL[entry.category],
    featured: entry.category === "popular",
    state: "available",
    stateLabel: LIBRARY_STATE_LABEL.available,
    steps: stepsFor(false, false, false),
    abilities: [entry.description.replace(/\.$/, "")],
    authority: { level: "medium", lines },
    handoff: "connectors",
    connectorId: entry.id,
    address: entry.url,
  };
}

function marketplaceItem(entry: ExtensionCatalogEntry): LibraryItem {
  return {
    id: `marketplace:${entry.extensionId}`,
    kind: "plugin",
    name: entry.displayName,
    summary: "Found in Marketplace. Review shows exactly what it holds before anything installs.",
    source: packageSource(entry.source),
    provider: "Every provider",
    featured: false,
    state: "available",
    stateLabel: LIBRARY_STATE_LABEL.available,
    steps: stepsFor(false, false, false),
    abilities: ["Review lists its parts before you install"],
    authority: { level: "none", lines: ["Unknown until you review it"] },
    handoff: "marketplace",
    version: String(entry.version),
  };
}

const ORIGIN_NAME = { "claude-code": "Claude Code", codex: "Codex" } as const;
const ORIGIN_LOGO = { "claude-code": "claude", codex: "codex" } as const;

function discoveredItems(listing: DiscoveredAgentToolingListing): ReadonlyArray<LibraryItem> {
  const servers = listing.servers.map<LibraryItem>((server) => ({
    id: `found-server:${server.id}`,
    kind: "mcp-server",
    name: server.name,
    summary: server.summary,
    source: `Found in ${ORIGIN_NAME[server.origin]}`,
    provider: ORIGIN_NAME[server.origin],
    providerLogo: ORIGIN_LOGO[server.origin],
    featured: false,
    state: "available",
    stateLabel: LIBRARY_STATE_LABEL.available,
    steps: stepsFor(false, false, false),
    abilities: [CAPABILITY_FACTS.mcp.ability],
    authority: {
      level: "medium",
      lines:
        server.transport === "stdio"
          ? ["Starts a program on this computer; every call still asks"]
          : [CAPABILITY_FACTS.mcp.cost],
    },
    handoff: "installed",
  }));
  const plugins = listing.plugins.map<LibraryItem>((plugin) => ({
    id: `found-plugin:${plugin.id}`,
    kind: "plugin",
    name: plugin.name,
    summary: `Installed in ${ORIGIN_NAME[plugin.origin]}${plugin.enabledThere ? "" : " (off there)"}.`,
    source: `Found in ${ORIGIN_NAME[plugin.origin]}`,
    provider: ORIGIN_NAME[plugin.origin],
    providerLogo: ORIGIN_LOGO[plugin.origin],
    featured: false,
    state: "available",
    stateLabel: LIBRARY_STATE_LABEL.available,
    steps: stepsFor(false, false, false),
    abilities: ["Review lists its parts before you add it"],
    authority: { level: "none", lines: ["Unknown until you review it"] },
    handoff: "installed",
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
  }));
  return [...servers, ...plugins];
}

/**
 * Every item the Library can show, from what is already in hand: the bundled
 * connector list, the installed set, and what a person already searched for
 * or scanned. Nothing here reads the network.
 */
export function buildLibrary(sources: LibrarySources): ReadonlyArray<LibraryItem> {
  const connectors = sources.connectors ?? connectorCatalog();
  const packages = (sources.snapshot?.packages ?? []).filter((pkg) => pkg.activation.installed);
  const installed = packages.map((pkg) => packageItem(pkg, connectors));
  const connected = new Set(
    installed.flatMap((item) => (item.connectorId ? [item.connectorId] : [])),
  );
  const installedIds = new Set(packages.map((pkg) => String(pkg.extensionId)));
  const items: LibraryItem[] = [
    ...installed,
    ...(sources.snapshot?.skills ?? []).map(skillItem),
    ...connectors.filter((entry) => !connected.has(entry.id)).map(connectorItem),
    ...(sources.marketplace ?? [])
      .filter((entry) => !installedIds.has(String(entry.extensionId)))
      .map(marketplaceItem),
    ...(sources.discovered === undefined ? [] : discoveredItems(sources.discovered)),
  ];
  return items;
}

export interface LibraryFilter {
  readonly query: string;
  readonly kind: LibraryKind | "all";
  readonly state: "all" | "installed" | "available" | "attention";
  readonly provider: string;
}

export const ALL_PROVIDERS = "all";

/** Installed, then needing a decision, before items nobody has set up. */
const STATE_RANK: Readonly<Record<LibraryState, number>> = {
  blocked: 0,
  "needs-trust": 1,
  off: 2,
  on: 3,
  available: 4,
};

export function filterLibrary(
  items: ReadonlyArray<LibraryItem>,
  filter: LibraryFilter,
): ReadonlyArray<LibraryItem> {
  const needle = filter.query.trim().toLocaleLowerCase();
  return items
    .filter((item) => filter.kind === "all" || item.kind === filter.kind)
    .filter((item) => {
      if (filter.state === "all") return true;
      if (filter.state === "available") return item.state === "available";
      if (filter.state === "installed") return item.state !== "available";
      return item.state === "blocked" || item.state === "needs-trust";
    })
    .filter((item) => filter.provider === ALL_PROVIDERS || item.provider === filter.provider)
    .filter(
      (item) =>
        needle === "" ||
        [item.name, item.summary, item.source, item.provider, item.category ?? ""].some((text) =>
          text.toLocaleLowerCase().includes(needle),
        ),
    )
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        STATE_RANK[a.item.state] - STATE_RANK[b.item.state] ||
        Number(b.item.featured) - Number(a.item.featured) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

export function libraryProviders(items: ReadonlyArray<LibraryItem>): ReadonlyArray<string> {
  return [...new Set(items.map((item) => item.provider))].sort((a, b) => a.localeCompare(b));
}

export function libraryCounts(
  items: ReadonlyArray<LibraryItem>,
): Readonly<Record<LibraryKind, number>> {
  const counts: Record<LibraryKind, number> = {
    connector: 0,
    plugin: 0,
    skill: 0,
    "mcp-server": 0,
  };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}
