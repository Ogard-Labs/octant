import "../styles.css";
import "../styles/shell.css";
import "../styles/dock.css";
import "../styles/panels.css";
import "../styles/environment.css";
import "../styles/components.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  decodeActivityView,
  type ActivityQuery,
  type ActivityView,
  type ActivityWindow,
  type HomeActivityCustomization,
} from "@octant/contracts/code-home-activity";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";
import type { HomeCardCustomization } from "@octant/contracts/shell";
import { CircleDot } from "../ui/icons";
import { IconDefaults } from "../ui/IconDefaults";
import { DraftThreadWorkspace } from "../shell/DraftThreadWorkspace";
import type { HomeListCardDefinition, HomeListRead } from "./homeCards";

/**
 * Rendered QA harness for the Code Home activity panel.
 *
 * Renders the real Code welcome — `DraftThreadWorkspace` in Code mode, which
 * mounts `HomeStartList` and the panel itself — against fake activity reads,
 * so a headless capture can record the card states a person actually sees.
 * `scripts/capture-code-home-activity.ts` drives it and opens the dialog
 * scenes; this page makes no network calls.
 */

const SNAPSHOT = "20000000-0000-4000-8000-000000000001";
const codeProjectId = "00000000-0000-4000-8000-000000000111" as ProjectId;

const scene = new URLSearchParams(window.location.search).get("scene") ?? "default";

const lastMonthAt = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();

/**
 * A timestamp `hour` hours into the queried window, so fixture rows always
 * sit inside the range the card resolved — a pinned Last month releases card
 * shows a last-month release, never one the window could not contain.
 */
function withinWindow(window: ActivityWindow, hour: number): string {
  const base = window.from === null ? new Date().setHours(0, 0, 0, 0) : Date.parse(window.from);
  return new Date(base + hour * 3_600_000).toISOString();
}

/** Today at `hour`:00 — inside Today and every wider shared range. */
function todayAt(hour: number): string {
  return new Date(new Date().setHours(hour, 0, 0, 0)).toISOString();
}

/** One Needs you row from last month, so the list above the panel is real. */
const needsYouCard: HomeListCardDefinition = {
  id: "needs-you",
  title: "Needs you",
  icon: CircleDot,
  defaultOn: true,
  available: true,
  useListRows: (): HomeListRead => ({
    status: "ready",
    rows: [
      {
        id: "needs-you-release-approval",
        section: "needs-you",
        glyph: "ask",
        tone: "warning",
        label: "Waiting",
        title: "Publish the release for the activity panel?",
        meta: ["Code · Octant · Terminal command", "Last month"],
        trailing: "Waiting",
        at: lastMonthAt,
      },
    ],
  }),
};

const projects = [
  {
    id: codeProjectId,
    type: "code",
    name: "Octant",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    binding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
    codeAccessPersistence: "current-session",
  },
] as unknown as ReadonlyArray<ProjectSummary>;

const runRecord = (
  id: string,
  finish: "successful" | "failed" | "canceled",
  label: string,
  occurredAt: string,
) => ({
  kind: "runs",
  occurredAt,
  id,
  label,
  source: "code",
  finish,
  mode: "code",
  threadId: "10000000-0000-4000-8000-0000000000aa",
  runId: id,
});

const mergedRecord = (number: number, occurredAt: string) => ({
  kind: "prs-merged",
  occurredAt,
  id: `octant-dev/octant#${String(number)}`,
  label: number === 41 ? "Ship the activity panel" : "Fix the release notes",
  repositoryOwner: "octant-dev",
  repositoryName: "octant",
  number,
  mergedBy: "henrik",
});

const issueRecord = (number: number, occurredAt: string) => ({
  kind: "issues-closed",
  occurredAt,
  id: `octant-dev/octant#${String(number)}`,
  label: "Panel reads compare the wrong window",
  repositoryOwner: "octant-dev",
  repositoryName: "octant",
  number,
});

const releaseRecord = (occurredAt: string) => ({
  kind: "releases-published",
  occurredAt,
  id: "octant-dev/octant#77",
  label: "v1.4.0",
  tag: "v1.4.0",
  url: "https://github.com/octant-dev/octant/releases/tag/v1.4.0",
});

function view(fields: Record<string, unknown>): ActivityView {
  return decodeActivityView({
    status: "ready",
    source: "github",
    checkedAt: new Date().toISOString(),
    ...fields,
  });
}

/** The answer each card gets for the scene; page reads serve the records dialog. */
function fixtureRead(query: ActivityQuery): Promise<ActivityView> {
  if (query.kind === "page") {
    return Promise.resolve(
      view({
        source: "octant",
        count: 3,
        finished: { successful: 3, failed: 2, canceled: 1 },
        snapshotId: query.snapshotId,
        records:
          query.allFinished === true
            ? [
                runRecord("run-9", "failed", "Broke the build", todayAt(17)),
                runRecord("run-8", "canceled", "Stopped the import", todayAt(16)),
                runRecord("run-1", "successful", "Fix the flaky test", todayAt(15)),
                runRecord("run-2", "successful", "Review the plan", todayAt(11)),
                runRecord("run-7", "failed", "Missed the deadline", todayAt(10)),
                runRecord("run-3", "successful", "Tidy the sidebar", todayAt(9)),
              ]
            : [
                runRecord("run-1", "successful", "Fix the flaky test", todayAt(15)),
                runRecord("run-2", "successful", "Review the plan", todayAt(11)),
                runRecord("run-3", "successful", "Tidy the sidebar", todayAt(9)),
              ],
      }),
    );
  }
  if (scene === "states") {
    switch (query.card) {
      case "prs-merged":
        return Promise.resolve(view({ count: 0, records: [] }));
      case "issues-closed":
        return Promise.resolve(
          view({
            status: "unavailable",
            reason: "rate-limited",
            records: [],
          }),
        );
      case "releases-published":
        return Promise.resolve(
          view({
            source: "octant",
            fallback: "no-github-connection",
            count: 2,
            records: [releaseRecord(withinWindow(query.current, 10))],
          }),
        );
      case "runs":
        return Promise.resolve(
          view({
            source: "octant",
            status: "partial",
            reason: "incomplete",
            count: 4,
            finished: { successful: 4, failed: 1, canceled: 0 },
            records: [
              runRecord(
                "run-1",
                "successful",
                "Fix the flaky test",
                withinWindow(query.current, 15),
              ),
            ],
          }),
        );
    }
  }
  switch (query.card) {
    case "prs-merged":
      return Promise.resolve(
        view({
          count: 12,
          comparisonCount: 5,
          snapshotId: SNAPSHOT,
          records: [
            mergedRecord(41, withinWindow(query.current, 15)),
            mergedRecord(38, withinWindow(query.current, 11)),
          ],
        }),
      );
    case "issues-closed":
      return Promise.resolve(
        view({
          count: 3,
          comparisonCount: 5,
          snapshotId: SNAPSHOT,
          records: [issueRecord(52, withinWindow(query.current, 14))],
        }),
      );
    case "releases-published":
      return Promise.resolve(
        view({
          count: 1,
          records: [releaseRecord(withinWindow(query.current, 10))],
        }),
      );
    case "runs":
      return Promise.resolve(
        view({
          source: "octant",
          count: 9,
          comparisonCount: 6,
          finished: { successful: 9, failed: 2, canceled: 1 },
          snapshotId: SNAPSHOT,
          records: [
            runRecord("run-1", "successful", "Fix the flaky test", withinWindow(query.current, 15)),
            runRecord("run-2", "successful", "Review the plan", withinWindow(query.current, 11)),
          ],
        }),
      );
  }
}

/** The customize scene opens with shared Today and Releases pinned to Last month. */
const initialCustomization: HomeCardCustomization =
  scene === "customize"
    ? {
        order: [],
        visibility: [],
        activity: {
          sharedRange: { kind: "today" },
          source: "github",
          pins: [{ card: "releases-published", range: { kind: "last-month" } }],
        } satisfies HomeActivityCustomization,
      }
    : { order: [], visibility: [] };

function Harness() {
  const [customization, setCustomization] = useState<HomeCardCustomization>(initialCustomization);
  return (
    <IconDefaults>
      <DraftThreadWorkspace
        homeStart={{
          cards: [needsYouCard],
          cardCustomization: customization,
          codeActivity: {
            read: fixtureRead,
            openThread: () => undefined,
            openExternal: () => undefined,
          },
          onCardCustomizationChange: setCustomization,
        }}
        mode="code"
        onCancel={() => undefined}
        onCreateThread={() => undefined}
        onSelectProvider={() => undefined}
        projectId={codeProjectId}
        projects={projects}
        providerGroups={[]}
      />
    </IconDefaults>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Harness root is missing.");
createRoot(rootElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
