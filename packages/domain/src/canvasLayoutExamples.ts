import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";

/**
 * Tabs and columns an agent is shown when it asks how to arrange a document.
 *
 * Wire shape, not branded blocks: describe returns these objects as-is. A
 * group names blocks that sit beside it in the same block list; the document
 * draws each named block inside its tab or track, once.
 */

const v = CANVAS_SCHEMA_VERSION;

/** One short tabbed section: two tabs over blocks the document also holds. */
export const tabbedOverviewExample = [
  {
    blockId: "overview",
    schemaVersion: v,
    kind: "tabs" as const,
    panes: [
      { label: "Summary", blockIds: ["summary-text"] },
      { label: "Risks", blockIds: ["risk-callout"] },
    ],
  },
  {
    blockId: "summary-text",
    schemaVersion: v,
    kind: "rich-text" as const,
    text: "The new sync engine ships behind a flag in the next release.",
  },
  {
    blockId: "risk-callout",
    schemaVersion: v,
    kind: "callout" as const,
    tone: "warning" as const,
    title: "Migration",
    text: "Older clients read the old journal until they update.",
  },
] as const;

const metric = (blockId: string, label: string, value: number, unit?: string) => ({
  blockId,
  schemaVersion: v,
  kind: "metric" as const,
  label,
  value,
  ...(unit === undefined ? {} : { unit }),
});

const note = (blockId: string, text: string) => ({
  blockId,
  schemaVersion: v,
  kind: "rich-text" as const,
  text,
});

const statusTable = (blockId: string, rows: ReadonlyArray<readonly [string, string, string]>) => ({
  blockId,
  schemaVersion: v,
  kind: "table" as const,
  columns: [
    { id: "item", label: "Item", type: "text" as const },
    { id: "owner", label: "Owner", type: "text" as const },
    { id: "status", label: "Status", type: "status" as const, display: "status" as const },
  ],
  rows: rows.map(([item, owner, status]) => [item, owner, status]),
});

/**
 * A game design brief in eight tabs: a dashboard of headline metrics, the
 * core loop as a flowchart, the world as a grouped zone map, and badge
 * tables, with a two-column sign-off below. It is the fixture the rendered
 * evidence and the share round trip draw.
 */
export const designBriefExample = [
  {
    blockId: "brief",
    schemaVersion: v,
    kind: "tabs" as const,
    panes: [
      { label: "Metrics", blockIds: ["metrics-board"] },
      { label: "Core loop", blockIds: ["loop"] },
      { label: "World", blockIds: ["zones"] },
      { label: "Economy", blockIds: ["economy-table"] },
      { label: "Content", blockIds: ["content-table"] },
      { label: "Live ops", blockIds: ["liveops-weekly", "liveops-seasonal"] },
      { label: "Risks", blockIds: ["risk-table"] },
      { label: "Open questions", blockIds: ["questions"] },
    ],
  },
  // A tab may hold a dashboard; the dashboard places the tiles, so the tab
  // names only the dashboard.
  {
    blockId: "metrics-board",
    schemaVersion: v,
    kind: "dashboard" as const,
    title: "Launch metrics",
    columns: 4,
    cells: [
      { blockId: "m-dau" },
      { blockId: "m-session" },
      { blockId: "m-retention" },
      { blockId: "m-arpdau" },
    ],
  },
  metric("m-dau", "Daily players", 48_200),
  metric("m-session", "Session length", 14, "min"),
  metric("m-retention", "Day-7 retention", 22, "%"),
  metric("m-arpdau", "Revenue per player", 0.12, "USD"),
  {
    blockId: "loop",
    schemaVersion: v,
    kind: "diagram" as const,
    flow: "down" as const,
    nodes: [
      { nodeId: "start", label: "Start run" },
      { nodeId: "explore", label: "Explore zone" },
      { nodeId: "fight", label: "Encounter?" },
      { nodeId: "loot", label: "Collect loot" },
      { nodeId: "upgrade", label: "Upgrade gear" },
      { nodeId: "end", label: "Return to camp" },
    ],
    edges: [
      { edgeId: "e1", source: "start", target: "explore" },
      { edgeId: "e2", source: "explore", target: "fight" },
      { edgeId: "e3", source: "fight", target: "loot", label: "win" },
      { edgeId: "e4", source: "fight", target: "end", label: "flee" },
      { edgeId: "e5", source: "loot", target: "upgrade" },
      { edgeId: "e6", source: "upgrade", target: "end" },
    ],
  },
  {
    blockId: "zones",
    schemaVersion: v,
    kind: "diagram" as const,
    flow: "right" as const,
    nodes: [
      { nodeId: "camp", label: "Camp" },
      { nodeId: "forest", label: "Forest" },
      { nodeId: "ruins", label: "Ruins" },
      { nodeId: "caves", label: "Caves" },
      { nodeId: "keep", label: "Keep" },
    ],
    edges: [
      { edgeId: "z1", source: "camp", target: "forest" },
      { edgeId: "z2", source: "forest", target: "ruins" },
      { edgeId: "z3", source: "forest", target: "caves" },
      { edgeId: "z4", source: "caves", target: "keep" },
    ],
    groups: [
      { groupId: "safe", label: "Safe", nodeIds: ["camp"] },
      { groupId: "wilds", label: "Wilds", nodeIds: ["forest", "ruins"] },
      { groupId: "deep", label: "Deep", nodeIds: ["caves", "keep"] },
    ],
  },
  statusTable("economy-table", [
    ["Gold sinks", "Economy", "success"],
    ["Gem pricing", "Economy", "warning"],
    ["Daily cap", "Design", "neutral"],
  ]),
  statusTable("content-table", [
    ["Forest biome", "Art", "success"],
    ["Keep boss", "Combat", "warning"],
    ["Caves lighting", "Tech art", "danger"],
  ]),
  note("liveops-weekly", "Weekly: a rotating zone modifier and one featured quest."),
  note("liveops-seasonal", "Seasonal: a new zone every ten weeks with its own track."),
  statusTable("risk-table", [
    ["Session length below target", "Design", "warning"],
    ["Store review", "Production", "neutral"],
    ["Server cost at launch", "Platform", "danger"],
  ]),
  note("questions", "Does the keep unlock by level or by story progress?"),
  // Below the tabs, side by side: who signs off. A column never holds tabs
  // or columns, so it sits beside the tabs, not in them.
  {
    blockId: "sign-off",
    schemaVersion: v,
    kind: "columns" as const,
    tracks: [{ blockIds: ["sign-off-design"] }, { blockIds: ["sign-off-production"] }],
  },
  note("sign-off-design", "Design signs off the loop and the zone map."),
  note("sign-off-production", "Production signs off scope and the launch window."),
] as const;
