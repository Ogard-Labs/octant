import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasBlock,
  type CanvasBlock,
} from "@octant/contracts/canvas";

/**
 * Dashboards an agent is shown when it asks how to lay one out.
 *
 * Wire shape, not branded blocks: describe returns these objects as-is. A
 * dashboard names the blocks it places, so each example is the dashboard
 * followed by the blocks it places, in the order a document would carry them.
 * The agent gathers the numbers with its own tools.
 */

const version = CANVAS_SCHEMA_VERSION;

/** An on-call view: headline numbers, two health lights, a trend, and the open incidents. */
export const opsDashboardExample = [
  {
    blockId: "ops-dashboard",
    schemaVersion: version,
    kind: "dashboard" as const,
    title: "Service health",
    columns: 4,
    cells: [
      { blockId: "ops-requests" },
      { blockId: "ops-latency" },
      { blockId: "ops-errors" },
      { blockId: "ops-api" },
      { blockId: "ops-latency-trend", span: 3 },
      { blockId: "ops-queue" },
      { blockId: "ops-incidents", span: 4 },
    ],
  },
  {
    blockId: "ops-requests",
    schemaVersion: version,
    kind: "metric" as const,
    label: "Requests per second",
    value: 1_840,
    format: "compact" as const,
    delta: 120,
    goodDirection: "neutral" as const,
    sparkline: [1610, 1650, 1700, 1720, 1790, 1840],
  },
  {
    blockId: "ops-latency",
    schemaVersion: version,
    kind: "metric" as const,
    label: "p95 latency",
    value: 212,
    unit: "ms",
    delta: -18,
    goodDirection: "down" as const,
    sparkline: [260, 248, 239, 230, 221, 212],
  },
  {
    blockId: "ops-errors",
    schemaVersion: version,
    kind: "metric" as const,
    label: "Error rate",
    value: 0.004,
    format: "percent" as const,
    delta: 0.001,
    goodDirection: "down" as const,
    caption: "last hour",
  },
  {
    blockId: "ops-api",
    schemaVersion: version,
    kind: "status" as const,
    label: "API",
    value: "Healthy",
    tone: "success" as const,
  },
  {
    blockId: "ops-latency-trend",
    schemaVersion: version,
    kind: "chart" as const,
    chartType: "line" as const,
    series: [
      {
        seriesId: "p50",
        label: "p50",
        points: [
          { x: "09:00", y: 88 },
          { x: "10:00", y: 91 },
          { x: "11:00", y: 86 },
          { x: "12:00", y: 84 },
        ],
      },
      {
        seriesId: "p95",
        label: "p95",
        points: [
          { x: "09:00", y: 260 },
          { x: "10:00", y: 239 },
          { x: "11:00", y: 221 },
          { x: "12:00", y: 212 },
        ],
      },
    ],
  },
  {
    blockId: "ops-queue",
    schemaVersion: version,
    kind: "status" as const,
    label: "Job queue",
    value: "Backlog 1.2k",
    tone: "warning" as const,
  },
  {
    blockId: "ops-incidents",
    schemaVersion: version,
    kind: "table" as const,
    columns: [
      { id: "incident", label: "Incident", type: "text" as const },
      { id: "severity", label: "Severity", type: "status" as const },
      { id: "age", label: "Open (h)", type: "number" as const },
    ],
    rows: [
      { id: "inc-412", cells: ["Slow search in eu-west", "warning", 3] },
      { id: "inc-409", cells: ["Webhook retries", "info", 11] },
    ],
  },
] as const;

/** A release health board: adoption and crash-free numbers, rollout state, crashes by build, and blockers. */
export const releaseHealthBoardExample = [
  {
    blockId: "release-board",
    schemaVersion: version,
    kind: "dashboard" as const,
    title: "Release 4.2 health",
    columns: 3,
    cells: [
      { blockId: "release-crash-free" },
      { blockId: "release-adoption" },
      { blockId: "release-rollout" },
      { blockId: "release-crashes", span: 2 },
      { blockId: "release-gate" },
      { blockId: "release-blockers", span: 3 },
    ],
  },
  {
    blockId: "release-crash-free",
    schemaVersion: version,
    kind: "metric" as const,
    label: "Crash-free sessions",
    value: 0.9962,
    format: "percent" as const,
    delta: 0.0011,
    goodDirection: "up" as const,
  },
  {
    blockId: "release-adoption",
    schemaVersion: version,
    kind: "metric" as const,
    label: "Adoption",
    value: 0.38,
    format: "percent" as const,
    sparkline: [0.02, 0.07, 0.15, 0.24, 0.31, 0.38],
    caption: "of active devices",
  },
  {
    blockId: "release-rollout",
    schemaVersion: version,
    kind: "progress" as const,
    label: "Staged rollout",
    value: 0.5,
    detail: "50% of users",
  },
  {
    blockId: "release-crashes",
    schemaVersion: version,
    kind: "chart" as const,
    chartType: "bar" as const,
    series: [
      {
        seriesId: "crashes",
        label: "Crashes per 10k sessions",
        points: [
          { x: "4.1.3", y: 9 },
          { x: "4.2.0", y: 6 },
          { x: "4.2.1", y: 4 },
        ],
      },
    ],
  },
  {
    blockId: "release-gate",
    schemaVersion: version,
    kind: "status" as const,
    label: "Go / no-go",
    value: "Hold at 50%",
    tone: "warning" as const,
  },
  {
    blockId: "release-blockers",
    schemaVersion: version,
    kind: "table" as const,
    columns: [
      { id: "issue", label: "Blocker", type: "text" as const },
      { id: "owner", label: "Owner", type: "text" as const },
      { id: "state", label: "State", type: "status" as const },
    ],
    rows: [
      { id: "crash-login", cells: ["Crash on login with SSO", "Mobile", "danger"] },
      { id: "sync-delay", cells: ["Sync delay after resume", "Platform", "warning"] },
    ],
  },
] as const;

export const dashboardExamples = [...opsDashboardExample, ...releaseHealthBoardExample] as const;

function decoded(blocks: ReadonlyArray<unknown>): ReadonlyArray<CanvasBlock> {
  return blocks.map((block) => decodeCanvasBlock(block));
}

export const opsDashboardExampleBlocks = decoded(opsDashboardExample);
export const releaseHealthBoardExampleBlocks = decoded(releaseHealthBoardExample);
