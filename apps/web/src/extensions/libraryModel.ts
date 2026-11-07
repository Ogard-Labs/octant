import type {
  DiscoveredAgentToolingListing,
  ExtensionCatalogEntry,
  ExtensionSnapshot,
  McpServerConnection,
} from "@octant/contracts/extension-rpc";
import type { ExtensionCapability } from "@octant/contracts/extensions";
import {
  PAPER_LOCAL_SETUP,
  CONNECTOR_CATEGORY_LABEL,
  connectorCatalog,
  connectorPackageName,
  featuredConnectors,
  type ConnectorAuth,
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
  /** One line on what it is; absent when the host gives none, so a card shows nothing rather than filler. */
  readonly summary?: string;
  /** Where it comes from, in the words the Installed view uses. */
  readonly source: string;
  /** The providers it is for, in words, or "Every provider". */
  readonly provider: string;
  /** Each provider it is for, one entry each, for filtering; "Every provider" when it names none. */
  readonly providers: ReadonlyArray<string>;
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
  readonly localSetupId?: "paper";
  /** How a connector signs in, so its detail can take a key or start a sign-in. */
  readonly connectorAuth?: ConnectorAuth;
  /** The connector server's component, once connected, for its sign-in control. */
  readonly mcpComponentId?: string;
  /**
   * How the package's MCP server is connecting, as the host last saw it; the
   * server most in need of attention when the package has several.
   */
  readonly connection?: Pick<McpServerConnection, "state" | "reason">;
  /** The Marketplace entry this item is, so it can be reviewed and installed here. */
  readonly marketplaceExtensionId?: string;
  readonly address?: string;
  readonly version?: string;
}

export interface LibrarySources {
  readonly snapshot: ExtensionSnapshot | undefined;
  /** Entries a person already searched for in Marketplace; never fetched here. */
  readonly marketplace?: ReadonlyArray<ExtensionCatalogEntry>;
  readonly discovered?: DiscoveredAgentToolingListing | undefined;
  readonly connectors?: ReadonlyArray<ConnectorCatalogEntry>;
  /** The host's connection listing, already read; never fetched here. */
  readonly connections?: ReadonlyArray<McpServerConnection>;
}

const ATTENTION: ReadonlyArray<McpServerConnection["state"]> = [
  "needs-sign-in",
  "failed",
  "blocked",
];

function connectionFor(
  item: LibraryItem,
  connections: ReadonlyArray<McpServerConnection>,
): LibraryItem {
  const extensionId = item.packageRef?.extensionId;
  if (extensionId === undefined) return item;
  const servers = connections.filter((server) => String(server.extensionId) === extensionId);
  const shown = servers.find((server) => ATTENTION.includes(server.state)) ?? servers[0];
  if (shown === undefined) return item;
  return {
    ...item,
    connection: {
      state: shown.state,
      ...(shown.reason === undefined ? {} : { reason: shown.reason }),
    },
  };
}

type Capability = ExtensionCapability;

/** Position in the hand-picked set; an item outside it is not featured. */
const FEATURED_RANK: ReadonlyMap<string, number> = new Map(
  featuredConnectors().map((entry, index) => [entry.id, index]),
);

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
    cost: "Starts or reaches a tool server; calls follow the thread's approval policy",
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

export function authorityFor(capabilities: ReadonlyArray<Capability>): LibraryAuthority {
  const facts = [...new Set(capabilities)]
    .map((capability) => CAPABILITY_FACTS[capability])
    .sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
  const first = facts[0];
  if (first === undefined) {
    return { level: "none", lines: ["Declares nothing beyond its description."] };
  }
  return { level: first.level, lines: facts.map((fact) => fact.cost) };
}

export function abilitiesFor(capabilities: ReadonlyArray<Capability>): ReadonlyArray<string> {
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
  const paper = pkg.addedInSettings === true && pkg.localSetupId === "paper";
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
  const providers = families.length === 0 ? [EVERY_PROVIDER] : families.map(String);
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
    source: paper
      ? "Local Paper setup"
      : connector !== undefined
        ? "Connector"
        : packageSource(pkg.source),
    provider: providers.join(", "),
    providers,
    ...(only === undefined ? {} : { providerLogo: only }),
    ...(connector === undefined ? {} : { category: CONNECTOR_CATEGORY_LABEL[connector.category] }),
    featured: connector !== undefined && FEATURED_RANK.has(connector.id),
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
    ...(paper
      ? {
          name: PAPER_LOCAL_SETUP.name,
          summary: PAPER_LOCAL_SETUP.description,
          authority: {
            level: "high" as const,
            lines: [
              "Reaches Paper Desktop on this host; tool calls follow the task's approval policy",
            ],
          },
          localSetupId: "paper" as const,
          address: PAPER_LOCAL_SETUP.url,
          stateLabel: state === "on" ? "Installed · on" : LIBRARY_STATE_LABEL[state],
          stateNote:
            state === "blocked"
              ? `Installed; tools unavailable${blockedBy?.effectiveState.kind === "blocked" ? `: ${blockedBy.effectiveState.reason.replaceAll("-", " ")}` : ""}. Paper Desktop and a file must also be open.`
              : "Installed; connection not checked. Paper Desktop and a file must be open before using its tools.",
        }
      : {}),
    ...(connector === undefined
      ? {}
      : {
          connectorId: connector.id,
          connectorAuth: connector.auth,
          address: connector.url,
          ...(server === undefined ? {} : { mcpComponentId: String(server.id) }),
        }),
  };
  return item;
}

/**
 * A discovered skill reaches the client with its document text but no
 * `description`; the host admits only one-line `key: value` frontmatter for
 * it, so the description is that one line. Nothing is read from disk here.
 */
function skillDescription(skill: StandaloneSkill): string | undefined {
  if (skill.description !== undefined) return skill.description;
  const text = skill.instructions;
  if (text === undefined || !text.startsWith("---\n")) return undefined;
  const closing = text.indexOf("\n---", 4);
  if (closing < 0) return undefined;
  for (const line of text.slice(4, closing).split("\n")) {
    const match = /^description\s*:\s*(\S.*)$/.exec(line);
    if (match === null) continue;
    const value = (match[1] ?? "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2")
      .trim();
    return value === "" || /^[>|][+-]?$/.test(value) ? undefined : value;
  }
  return undefined;
}

function skillItem(skill: StandaloneSkill): LibraryItem {
  const description = skillDescription(skill);
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
    ...(description === undefined ? {} : { summary: description }),
    source: packageSource(skill.source),
    provider: EVERY_PROVIDER,
    providers: [EVERY_PROVIDER],
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
  const lines = [`Sends your requests to ${host}; tool calls follow the thread's approval policy`];
  if (entry.auth.kind === "sign-in")
    lines.push(`Signs in to ${host} and keeps the grant in the credential store`);
  if (entry.auth.kind === "key") lines.push("Uses a key you create, kept in the credential store");
  return {
    id: `connector:${entry.id}`,
    kind: "connector",
    name: entry.displayName,
    summary: entry.description,
    source: "Connector catalog",
    provider: EVERY_PROVIDER,
    providers: [EVERY_PROVIDER],
    category: CONNECTOR_CATEGORY_LABEL[entry.category],
    featured: FEATURED_RANK.has(entry.id),
    state: "available",
    stateLabel: LIBRARY_STATE_LABEL.available,
    steps: stepsFor(false, false, false),
    abilities: [entry.description.replace(/\.$/, "")],
    authority: { level: "medium", lines },
    handoff: "connectors",
    connectorId: entry.id,
    connectorAuth: entry.auth,
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
    provider: EVERY_PROVIDER,
    providers: [EVERY_PROVIDER],
    featured: false,
    state: "available",
    stateLabel: LIBRARY_STATE_LABEL.available,
    steps: stepsFor(false, false, false),
    abilities: ["Review lists its parts before you install"],
    authority: { level: "none", lines: ["Unknown until you review it"] },
    handoff: "marketplace",
    marketplaceExtensionId: String(entry.extensionId),
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
    providers: [ORIGIN_NAME[server.origin]],
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
          ? ["Starts a program on this computer; calls follow the thread's approval policy"]
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
    providers: [ORIGIN_NAME[plugin.origin]],
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
  // A plugin built into Octant has only its switch, under Installed; it is not
  // something to find, review, or install.
  const packages = (sources.snapshot?.packages ?? []).filter(
    (pkg) => pkg.activation.installed && pkg.source.kind !== "bundled",
  );
  const installed = packages.map((pkg) =>
    connectionFor(packageItem(pkg, connectors), sources.connections ?? []),
  );
  const connected = new Set(
    installed.flatMap((item) => (item.connectorId ? [item.connectorId] : [])),
  );
  const installedIds = new Set(packages.map((pkg) => String(pkg.extensionId)));
  const items: LibraryItem[] = [
    ...installed,
    ...(sources.snapshot?.skills ?? []).map(skillItem),
    ...connectors.filter((entry) => !connected.has(entry.id)).map(connectorItem),
    ...(installed.some((item) => item.localSetupId === "paper") ? [] : [paperSetupItem()]),
    ...(sources.marketplace ?? [])
      .filter((entry) => !installedIds.has(String(entry.extensionId)))
      .map(marketplaceItem),
    ...(sources.discovered === undefined ? [] : discoveredItems(sources.discovered)),
  ];
  return items;
}

function paperSetupItem(): LibraryItem {
  return {
    id: "local-setup:paper",
    category: "On this computer",
    kind: "mcp-server",
    name: PAPER_LOCAL_SETUP.name,
    summary: PAPER_LOCAL_SETUP.description,
    source: "Local Paper setup",
    provider: EVERY_PROVIDER,
    providers: [EVERY_PROVIDER],
    featured: false,
    state: "available",
    stateLabel: "Not added",
    steps: stepsFor(false, false, false),
    stateNote: "Requires Paper Desktop with a file open; availability has not been checked.",
    abilities: ["Read and edit the open design through Paper's local tools"],
    authority: {
      level: "high",
      lines: ["Reaches Paper Desktop on this host; tool calls follow the task's approval policy"],
    },
    handoff: "installed",
    localSetupId: "paper",
    address: PAPER_LOCAL_SETUP.url,
  };
}

export interface LibraryFilter {
  readonly query: string;
  readonly kind: LibraryKind | "all";
  readonly state: "all" | "installed" | "available" | "attention";
  readonly provider: string;
}

export const ALL_PROVIDERS = "all";
const EVERY_PROVIDER = "Every provider";

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
    .filter(
      (item) =>
        filter.provider === ALL_PROVIDERS ||
        item.providers.includes(filter.provider) ||
        // An item that names no provider works with every one of them.
        item.providers.includes(EVERY_PROVIDER),
    )
    .filter(
      (item) =>
        needle === "" ||
        [item.name, item.summary ?? "", item.source, item.provider, item.category ?? ""].some(
          (text) => text.toLocaleLowerCase().includes(needle),
        ),
    )
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        STATE_RANK[a.item.state] - STATE_RANK[b.item.state] ||
        (FEATURED_RANK.get(a.item.connectorId ?? "") ?? Infinity) -
          (FEATURED_RANK.get(b.item.connectorId ?? "") ?? Infinity) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

export function libraryProviders(items: ReadonlyArray<LibraryItem>): ReadonlyArray<string> {
  return [...new Set(items.flatMap((item) => item.providers))]
    .filter((provider) => provider !== EVERY_PROVIDER)
    .sort((a, b) => a.localeCompare(b));
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

/** What a person already narrowed to; the lead row and the groups only make sense with none of it. */
export function isBrowsing(filter: LibraryFilter): boolean {
  return filter.query.trim() === "" && filter.provider === ALL_PROVIDERS;
}

/**
 * The hand-picked connectors, in the order they were picked. The set is fixed:
 * a connected one stays and shows its state on its card, so the row never has
 * a hole. They lead the page while a person is browsing everything or
 * connectors. An available one leaves the groups below so it shows once; a
 * connected one also stays under Installed, where its state is acted on.
 * Narrowing to not-installed shows only the featured ones that are not.
 */
export function featuredItems(
  items: ReadonlyArray<LibraryItem>,
  filter: LibraryFilter,
): ReadonlyArray<LibraryItem> {
  if (!isBrowsing(filter)) return [];
  if (filter.kind !== "all" && filter.kind !== "connector") return [];
  if (filter.state === "installed" || filter.state === "attention") return [];
  return items
    .filter((item) => item.featured)
    .sort(
      (a, b) =>
        (FEATURED_RANK.get(a.connectorId ?? "") ?? Infinity) -
        (FEATURED_RANK.get(b.connectorId ?? "") ?? Infinity),
    );
}

export interface LibraryGroup {
  readonly key: string;
  readonly title: string;
  readonly items: ReadonlyArray<LibraryItem>;
}

const CATEGORY_ORDER = ["Popular", "Developer tools", "Business"] as const;

function availableGroupTitle(item: LibraryItem): string {
  if (item.category !== undefined) return item.category;
  if (item.id.startsWith("found-")) return "Found on this computer";
  if (item.id.startsWith("marketplace:")) return "From Marketplace";
  return "More";
}

/**
 * Groups for the filtered items: what a person already has first, with what
 * needs a decision at its head, then what is not installed by the catalog's
 * own categories, Marketplace results, and tools found in Claude Code and
 * Codex. A search is one flat list of results; the lead row's items are left
 * out so they show once.
 */
export function groupLibrary(
  shown: ReadonlyArray<LibraryItem>,
  filter: LibraryFilter,
): ReadonlyArray<LibraryGroup> {
  if (filter.query.trim() !== "") {
    return shown.length === 0 ? [] : [{ key: "results", title: "Results", items: shown }];
  }
  const lead = new Set(
    featuredItems(shown, filter)
      .filter((item) => item.state === "available")
      .map((item) => item.id),
  );
  const rest = shown.filter((item) => !lead.has(item.id));
  const groups: LibraryGroup[] = [];
  const installed = rest.filter((item) => item.state !== "available");
  if (installed.length > 0) groups.push({ key: "installed", title: "Installed", items: installed });
  const titles: string[] = [];
  for (const item of rest) {
    if (item.state !== "available") continue;
    const title = availableGroupTitle(item);
    if (!titles.includes(title)) titles.push(title);
  }
  const rank = (title: string) => {
    const at = (CATEGORY_ORDER as ReadonlyArray<string>).indexOf(title);
    return at === -1 ? CATEGORY_ORDER.length : at;
  };
  titles.sort((a, b) => rank(a) - rank(b));
  for (const title of titles) {
    groups.push({
      key: title,
      title,
      items: rest.filter(
        (item) => item.state === "available" && availableGroupTitle(item) === title,
      ),
    });
  }
  return groups;
}
