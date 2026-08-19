import type {
  WorkspacePreset,
  WorkspacePresetPane,
  WorkspacePresetSkillReport,
} from "@octant/contracts/workspace-presets";
import type { CodeThreadId } from "@octant/contracts/code";
import type { MentionableThreadId } from "@octant/contracts";
import type {
  TabGroupId,
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
  readonly groupId: TabGroupId;
  readonly mintTabId: () => WorkspaceTabId;
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
 * The panes open in the group the thread is already working in, in the order
 * the preset lists them, and the first one is left in front. Splitting them
 * apart stays the user's: an arrangement the host imposed would be one more
 * thing to undo.
 */
export function planWorkspacePreset(
  input: WorkspacePresetPlanInput,
): ReadonlyArray<WorkspaceOperation> {
  const operations: WorkspaceOperation[] = [];
  let leadTabId: WorkspaceTabId | undefined;
  for (const pane of input.preset.panes) {
    const tabId = input.mintTabId();
    leadTabId ??= tabId;
    operations.push({
      kind: "open-tab",
      mode: "code",
      groupId: input.groupId,
      tab: presetTab(pane, tabId, input.thread),
    });
  }
  if (leadTabId !== undefined) {
    operations.push({
      kind: "activate-tab",
      mode: "code",
      groupId: input.groupId,
      tabId: leadTabId,
    });
  }
  return operations;
}

function presetTab(
  pane: WorkspacePresetPane,
  id: WorkspaceTabId,
  thread: WorkspacePresetThread,
): Extract<WorkspaceOperation, { kind: "open-tab" }>["tab"] {
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
 * The group a preset's panes should open into: the one already showing this
 * Code thread.
 *
 * Resolved from the window's own layout rather than from the request, so a
 * preset lands on a thread the window already has open. A caller naming a
 * thread it cannot see gets nothing back, and nothing is opened.
 */
export function findWorkspacePresetTarget(
  layout: WorkspaceLayoutNode,
  threadId: CodeThreadId,
): { readonly groupId: TabGroupId; readonly title: string } | undefined {
  if (layout.kind === "group") {
    for (const tab of layout.tabs) {
      if ("threadId" in tab && String(tab.threadId) === String(threadId)) {
        return { groupId: layout.groupId, title: tab.title };
      }
    }
    return undefined;
  }
  return (
    findWorkspacePresetTarget(layout.first, threadId) ??
    findWorkspacePresetTarget(layout.second, threadId)
  );
}
