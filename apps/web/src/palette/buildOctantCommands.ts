import type { OctantMode } from "@octant/contracts/modes";
import type { OctantCommand } from "./commandModel";

/**
 * The host facts every command is derived from.
 *
 * Nothing here is invented by the renderer: each list is something the shell
 * already holds and already renders elsewhere. A source the host cannot answer
 * for arrives empty, and contributes no commands rather than a dead entry.
 */
export interface OctantCommandSources {
  readonly activeMode: OctantMode;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly onSelectMode: (mode: OctantMode) => void;
  readonly onNewThread: () => void;
  readonly onOpenSearch: () => void;
  readonly onOpenSettings: () => void;
  /** Opens Zen. Absent when this window cannot enter it. */
  readonly onOpenZen?: () => void;
  readonly threads: ReadonlyArray<CommandThread>;
  readonly onOpenThread: (thread: CommandThread) => void;
  readonly projects: ReadonlyArray<CommandProject>;
  readonly onOpenProject: (project: CommandProject) => void;
  readonly profiles: ReadonlyArray<CommandAgentProfile>;
  readonly onSelectProfile: (profile: CommandAgentProfile) => void;
  readonly skills: ReadonlyArray<CommandSkill>;
  /**
   * Apple projects the host listed in the active Code thread's checkout. A
   * thread with none contributes no workbench command, because there would be
   * nothing for the workbench to open.
   */
  readonly appleProjects: ReadonlyArray<CommandAppleProject>;
  readonly onOpenAppleProject: (project: CommandAppleProject) => void;
}

export interface CommandThread {
  readonly threadId: string;
  readonly title: string;
  readonly mode: OctantMode;
  /**
   * The thread's own Project. The open callback must pass this through, or a
   * cross-Project open dispatches a plain open-tab that the
   * server-authoritative workspace policy rightly rejects.
   */
  readonly projectId?: string;
}

export interface CommandProject {
  readonly projectId: string;
  readonly name: string;
  readonly mode: OctantMode;
}

export interface CommandAgentProfile {
  readonly profileId: string;
  readonly displayName: string;
  /** Words for the policy this profile defaults to; never a colour. */
  readonly executionPolicyLabel: string;
}

export interface CommandAppleProject {
  /** Checkout-relative path to the `.xcodeproj` or `.xcworkspace`. */
  readonly projectPath: string;
  readonly name: string;
}

export interface CommandSkill {
  /**
   * The source-qualified skill id. It is also the composer reference body, so
   * the host resolves the exact skill the row named rather than a name that
   * two installed packages could both claim.
   */
  readonly skillId: string;
  readonly displayName: string;
}

const MODE_LABEL: Record<OctantMode, string> = { chat: "Chat", work: "Work", code: "Code" };
const NEW_THREAD_LABEL: Record<OctantMode, string> = {
  chat: "New chat",
  work: "New Work thread",
  code: "New Code thread",
};

/** How many threads and projects one palette query is willing to enumerate. */
const MAX_NAVIGATION_ENTRIES = 40;

/**
 * Build the command list from what the host offers.
 *
 * Every command closes over the callback the equivalent visible control already
 * uses, so running one is indistinguishable — to the server — from clicking
 * that control. Nothing here decides whether an action is permitted.
 */
export function buildOctantCommands(sources: OctantCommandSources): ReadonlyArray<OctantCommand> {
  const commands: Array<OctantCommand> = [];

  for (const mode of sources.modes) {
    if (mode === sources.activeMode) continue;
    commands.push({
      id: `mode:${mode}`,
      title: `Switch to ${MODE_LABEL[mode]}`,
      group: "Modes",
      keywords: ["mode", MODE_LABEL[mode]],
      action: { kind: "run", run: () => sources.onSelectMode(mode) },
    });
  }

  commands.push({
    id: `thread:new:${sources.activeMode}`,
    title: NEW_THREAD_LABEL[sources.activeMode],
    group: "Threads",
    detail: MODE_LABEL[sources.activeMode],
    keywords: ["create", "draft", "start"],
    action: { kind: "run", run: sources.onNewThread },
  });
  commands.push({
    id: "thread:search",
    title: `Search ${MODE_LABEL[sources.activeMode]} threads`,
    group: "Threads",
    keywords: ["find", "filter"],
    action: { kind: "run", run: sources.onOpenSearch },
  });
  for (const thread of sources.threads.slice(0, MAX_NAVIGATION_ENTRIES)) {
    commands.push({
      id: `thread:${thread.mode}:${thread.threadId}`,
      title: `Open ${thread.title}`,
      group: "Threads",
      detail: `${MODE_LABEL[thread.mode]} thread`,
      keywords: [thread.title],
      action: { kind: "run", run: () => sources.onOpenThread(thread) },
    });
  }

  for (const project of sources.projects.slice(0, MAX_NAVIGATION_ENTRIES)) {
    commands.push({
      id: `project:${project.projectId}`,
      title: `Open ${project.name}`,
      group: "Projects",
      detail: `${MODE_LABEL[project.mode]} Project`,
      keywords: [project.name],
      action: { kind: "run", run: () => sources.onOpenProject(project) },
    });
  }

  for (const profile of sources.profiles) {
    commands.push({
      id: `profile:${profile.profileId}`,
      title: `Use ${profile.displayName}`,
      group: "Agent profiles",
      detail: profile.executionPolicyLabel,
      keywords: ["agent", "profile", profile.displayName],
      action: { kind: "run", run: () => sources.onSelectProfile(profile) },
    });
  }

  for (const skill of sources.skills) {
    commands.push({
      id: `skill:${skill.skillId}`,
      title: skill.displayName,
      group: "Skills",
      detail: "Skill",
      keywords: ["skill", skill.skillId],
      action: { kind: "address", reference: `$${skill.skillId}` },
    });
  }

  for (const project of sources.appleProjects.slice(0, MAX_NAVIGATION_ENTRIES)) {
    commands.push({
      id: `apple:${project.projectPath}`,
      title: `Open Apple workbench for ${project.name}`,
      group: "Workspace",
      detail: "Build, run, and Simulator destinations",
      keywords: ["apple", "xcode", "simulator", "build", "run", project.name],
      action: { kind: "run", run: () => sources.onOpenAppleProject(project) },
    });
  }

  commands.push({
    id: "settings:open",
    title: "Open Settings",
    group: "Settings",
    keywords: ["preferences", "providers", "appearance"],
    action: { kind: "run", run: sources.onOpenSettings },
  });

  if (sources.onOpenZen !== undefined) {
    commands.push({
      id: "workspace:zen-mode",
      title: "Toggle Zen mode",
      group: "Workspace",
      keywords: ["focus", "zen"],
      action: { kind: "run", run: sources.onOpenZen },
    });
  }

  return commands;
}
