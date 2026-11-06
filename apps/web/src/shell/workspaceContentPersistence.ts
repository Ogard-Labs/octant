import { Schema } from "effect";
import {
  PaneId,
  WorkspaceTab,
  WindowWorkspace,
  type WorkspaceLayoutNode,
  type WindowId,
} from "@octant/contracts";
import type { WorkspaceContentTabs } from "./workspaceContentTabs";

const modes = ["chat", "work", "code"] as const;
const SavedContent = Schema.Struct({
  version: Schema.Literal(1),
  contexts: WindowWorkspace.fields.contextByMode,
  panes: Schema.Array(
    Schema.Struct({
      paneId: PaneId,
      mode: Schema.Literal(...modes),
      tabs: Schema.Array(WorkspaceTab).pipe(Schema.maxItems(128)),
    }),
  ).pipe(Schema.maxItems(64)),
});
function paneIds(layout: WorkspaceLayoutNode): ReadonlyArray<PaneId> {
  return layout.kind === "pane"
    ? [layout.paneId]
    : [...paneIds(layout.first), ...paneIds(layout.second)];
}
function isContent(tab: WorkspaceTab): boolean {
  return ["chat-thread", "work-thread", "code-overview", "code-file", "preview", "canvas"].includes(
    tab.kind,
  );
}
export function workspaceContentStorageKey(
  serverUrl: string,
  windowId: WindowId,
): string | undefined {
  try {
    const url = new URL(serverUrl);
    return `octant.workspace.kept-tabs.v1:${url.origin}${url.pathname}:${windowId}`;
  } catch {
    return undefined;
  }
}

/** References only: selection continues to come from the authoritative persisted workspace. */
export function encodeWorkspaceContent(
  workspace: WindowWorkspace,
  tabs: WorkspaceContentTabs,
  preview: ReadonlySet<string>,
): string {
  return JSON.stringify({
    version: 1,
    contexts: workspace.contextByMode,
    panes: modes.flatMap((mode) =>
      paneIds(workspace.layouts[mode]).map((paneId) => ({
        paneId,
        mode,
        tabs: (tabs.get(paneId) ?? [])
          .filter(
            (tab) =>
              isContent(tab) &&
              !("threadId" in tab && tab.threadId !== null && preview.has(String(tab.threadId))),
          )
          .slice(-128),
      })),
    ),
  });
}

export function decodeWorkspaceContent(
  serialized: string | null,
  workspace: WindowWorkspace,
): WorkspaceContentTabs {
  if (serialized === null || serialized.length > 512 * 1024) return new Map();
  try {
    const saved = Schema.decodeUnknownSync(SavedContent)(JSON.parse(serialized));
    const restored = new Map<PaneId, ReadonlyArray<WorkspaceTab>>();
    for (const pane of saved.panes) {
      if (
        JSON.stringify(saved.contexts[pane.mode]) !==
          JSON.stringify(workspace.contextByMode[pane.mode]) ||
        !paneIds(workspace.layouts[pane.mode]).includes(pane.paneId)
      )
        continue;
      restored.set(
        pane.paneId,
        pane.tabs.filter((tab) => isContent(tab) && "mode" in tab && tab.mode === pane.mode),
      );
    }
    return restored;
  } catch {
    return new Map();
  }
}

export function readWorkspaceContent(
  key: string | undefined,
  workspace: WindowWorkspace,
): WorkspaceContentTabs {
  try {
    return key === undefined
      ? new Map()
      : decodeWorkspaceContent(globalThis.localStorage.getItem(key), workspace);
  } catch {
    return new Map();
  }
}
export function writeWorkspaceContent(
  key: string | undefined,
  workspace: WindowWorkspace,
  tabs: WorkspaceContentTabs,
  preview: ReadonlySet<string>,
): void {
  try {
    if (key === undefined) return;
    const previous = globalThis.localStorage.getItem(key);
    if (previous === null && [...tabs.values()].every((entries) => entries.length === 0)) return;
    const serialized = encodeWorkspaceContent(workspace, tabs, preview);
    if (serialized !== previous) globalThis.localStorage.setItem(key, serialized);
  } catch {
    /* A full or unavailable local store must not break navigation. */
  }
}
