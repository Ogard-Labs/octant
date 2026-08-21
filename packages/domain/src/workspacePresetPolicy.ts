import type {
  WorkspacePreset,
  WorkspacePresetPane,
  WorkspacePresetSkillReport,
} from "@octant/contracts/workspace-presets";
import type { CodeThreadId } from "@octant/contracts/code";
import type { MentionableThreadId } from "@octant/contracts";
import type {
  LayoutNodeId,
  PaneId,
  SplitRatio,
  WorkspaceLayoutNode,
  WorkspaceOperation,
  WorkspaceTabId,
} from "@octant/contracts/shell";

export interface WorkspacePresetThread {
  readonly threadId: CodeThreadId;
  /**
   * The same thread under the identity Side Chat addresses it by. Supplied
   * rather than derived: one thread has one identity, and a policy that
   * rebranded an id would be inventing a value the caller never authorized.
   */
  readonly mentionableThreadId: MentionableThreadId;
  readonly title: string;
}

export interface WorkspacePresetPlanInput {
  readonly preset: WorkspacePreset;
  readonly thread: WorkspacePresetThread;
  readonly paneId: PaneId;
  readonly mintTabId: () => WorkspaceTabId;
  readonly mintPaneId: () => PaneId;
  readonly mintNodeId: () => LayoutNodeId;
}

/**
 * The operations a preset performs, composed from the pinned record.
 *
 * Every one of them opens a surface the thread could already open for itself,
 * against the thread it was applied to. A preset arranges what a thread has;
 * it is never a way to reach a surface the thread could not open on its own,
 * which is why the pane list is closed and the thread is the caller's rather
 * than something the preset names.
 *
 * A pane holds one surface, so each preset surface after the first splits off
 * the pane the thread is already working in; the first replaces that pane's
 * content and is refocused at the end so it is left in front. The split ratio
 * shrinks the existing side as surfaces accumulate so the panes come out
 * roughly even rather than halving into a sliver.
 */
export function planWorkspacePreset(
  input: WorkspacePresetPlanInput,
): ReadonlyArray<WorkspaceOperation> {
  const operations: WorkspaceOperation[] = [];
  const [lead, ...rest] = input.preset.panes;
  if (lead === undefined) return operations;
  const leadSurface = presetSurface(lead, input.mintTabId(), input.thread);
  operations.push({
    kind: "open-surface",
    mode: "code",
    paneId: input.paneId,
    surface: leadSurface,
  });
  for (const [index, pane] of rest.entries()) {
    operations.push({
      kind: "split-pane",
      mode: "code",
      targetPaneId: input.paneId,
      surface: presetSurface(pane, input.mintTabId(), input.thread),
      splitNodeId: input.mintNodeId(),
      newPaneNodeId: input.mintNodeId(),
      newPaneId: input.mintPaneId(),
      orientation: "horizontal",
      placement: "after",
      // The lead keeps 1/2, then 1/3, then 1/4 of its remaining width so the
      // panes come out roughly even instead of halving into a sliver.
      ratio: Math.max(0.2, 1 / (index + 2)) as SplitRatio,
    });
  }
  if (rest.length > 0) {
    // Splitting activates each new pane in turn; re-opening the lead surface
    // finds it already visible and activates its pane, leaving it in front.
    operations.push({
      kind: "open-surface",
      mode: "code",
      paneId: input.paneId,
      surface: leadSurface,
    });
  }
  return operations;
}

function presetSurface(
  pane: WorkspacePresetPane,
  id: WorkspaceTabId,
  thread: WorkspacePresetThread,
): Extract<WorkspaceOperation, { kind: "open-surface" }>["surface"] {
  switch (pane) {
    case "code-overview":
      return {
        kind: "code-overview",
        id,
        threadId: thread.threadId,
        mode: "code",
        title: thread.title,
      };
    case "code-terminal":
      return {
        kind: "code-terminal",
        id,
        threadId: thread.threadId,
        mode: "code",
        title: "Terminal",
      };
    case "browser":
      return { kind: "browser", id, mode: "code", title: "Preview" };
    case "files":
      return { kind: "files", id, mode: "code", title: "Files" };
    case "side-chat":
      return {
        kind: "side-chat",
        id,
        mode: "code",
        title: "Side Chat",
        sourceThreadId: thread.mentionableThreadId,
      };
  }
}

/**
 * Where each of a preset's named skills stands for this thread.
 *
 * A report, never a change. Applying a preset installs nothing, trusts
 * nothing, enables nothing, and elevates nothing: a skill the thread cannot
 * already use is reported as missing, and the person decides whether to go and
 * get it. A preset that could enable a skill would be an installation path
 * that skipped every deliberate step the ladder exists to require.
 *
 * `available` is what the thread's own resolved catalog says — skills that
 * survived scope filtering, with the effective state activation left them in.
 */
export function reportWorkspacePresetSkills(
  preset: WorkspacePreset,
  available: ReadonlyArray<{ readonly name: string; readonly enabled: boolean }>,
): ReadonlyArray<WorkspacePresetSkillReport> {
  return preset.defaultSkills.map((name) => {
    const present = available.filter((skill) => skill.name === name);
    if (present.length === 0) return { name, status: "not-installed" };
    // Any enabled copy is enough for the thread to use the skill; a second,
    // disabled copy of the same name does not take that away.
    return {
      name,
      status: present.some((skill) => skill.enabled) ? "active" : "installed-not-enabled",
    };
  });
}

/**
 * The pane a preset's surfaces should open against: the one already showing
 * this Code thread.
 *
 * Resolved from the window's own layout rather than from the request, so a
 * preset lands on a thread the window already has open. A caller naming a
 * thread it cannot see gets nothing back, and nothing is opened.
 */
export function findWorkspacePresetTarget(
  layout: WorkspaceLayoutNode,
  threadId: CodeThreadId,
): { readonly paneId: PaneId; readonly title: string } | undefined {
  if (layout.kind === "pane") {
    const surface = layout.surface;
    if ("threadId" in surface && String(surface.threadId) === String(threadId)) {
      return { paneId: layout.paneId, title: surface.title };
    }
    return undefined;
  }
  return (
    findWorkspacePresetTarget(layout.first, threadId) ??
    findWorkspacePresetTarget(layout.second, threadId)
  );
}
