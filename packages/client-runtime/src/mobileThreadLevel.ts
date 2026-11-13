import {
  CodeBootstrap,
  decodeHostAnswer,
  ProjectBootstrap,
  WorkThreadBootstrap,
  type CodeSettings,
  type CodeThread,
  type PermissionMode,
  type ProjectSummary,
  type WorkSettings,
  type WorkThread,
} from "@octant/contracts";
import {
  permissionModeOf,
  permissionModeOfWorkAccess,
  threadAccessOf,
  workAccessOfPermissionMode,
} from "@octant/domain";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/**
 * A Work or Code thread's level, set from a phone the host's own person
 * paired. Such a device sets a level as a local window does (maintainer
 * decision, 2026-11-12), so this sends the commands a window sends and asks
 * for no owner unlock. The host still decides: a session it holds to the
 * catalogue is refused, and the refusal is reported as it is.
 */
export type MobileThreadLevelSubject =
  | {
      readonly mode: "code";
      readonly thread: Pick<
        CodeThread,
        "id" | "version" | "executionPolicy" | "permissionPersistence" | "autoApprove"
      >;
    }
  | { readonly mode: "work"; readonly thread: Pick<WorkThread, "id" | "version" | "access"> };

export const MOBILE_THREAD_LEVEL_LABELS: Readonly<Record<PermissionMode, string>> = {
  auto: "Auto",
  "ask-first": "Ask first",
  "accept-edits": "Accept edits",
  plan: "Plan",
  "full-access": "Full access",
};

/** Said before the first Full access pick, in the words the desktop warning uses. */
export const MOBILE_FULL_ACCESS_WARNING =
  "Agents can change any file and run any command without asking, with no sandbox. Protected files, such as SSH and cloud keys, are guarded by Octant's own tools and redaction only, and a shell command can read them.";

const CODE_LEVELS: ReadonlyArray<PermissionMode> = [
  "auto",
  "ask-first",
  "accept-edits",
  "plan",
  "full-access",
];
// Work shares Code's levels and has no Plan overlay.
const WORK_LEVELS = CODE_LEVELS.filter((level) => level !== "plan");

export function mobileThreadLevelChoices(mode: "code" | "work"): ReadonlyArray<PermissionMode> {
  return mode === "work" ? WORK_LEVELS : CODE_LEVELS;
}

export function mobileThreadLevel(subject: MobileThreadLevelSubject): PermissionMode {
  return subject.mode === "work"
    ? permissionModeOfWorkAccess(subject.thread.access)
    : permissionModeOf({
        executionPolicy: subject.thread.executionPolicy,
        autoApprove: subject.thread.autoApprove,
      });
}

export type MobileThreadLevelChange =
  | { readonly status: "changed" }
  | { readonly status: "refused"; readonly message: string };

const REFUSED: MobileThreadLevelChange = {
  status: "refused",
  message: "The host did not change this thread's mode.",
};

/** Sends one change against the version the phone read; a refusal is never retried. */
export async function changeMobileThreadLevel(input: {
  readonly transport: MobileRemoteTransport;
  readonly subject: MobileThreadLevelSubject;
  readonly level: PermissionMode;
}): Promise<MobileThreadLevelChange> {
  const { subject } = input;
  let path: string;
  let command: Record<string, unknown>;
  if (subject.mode === "work") {
    const access = workAccessOfPermissionMode(input.level);
    if (access === undefined) return REFUSED;
    path = "/api/work/threads/commands";
    command = {
      kind: "change-work-thread-access",
      threadId: subject.thread.id,
      expectedVersion: subject.thread.version,
      access,
    };
  } else {
    const access = threadAccessOf(input.level);
    path = "/api/code/commands";
    command = {
      kind: "change-code-thread-access",
      threadId: subject.thread.id,
      expectedVersion: subject.thread.version,
      executionPolicy: access.executionPolicy,
      permissionPersistence: subject.thread.permissionPersistence,
      autoApprove: access.autoApprove,
    };
  }
  return sendLevelCommand(input.transport, path, command, ["thread-updated"], REFUSED);
}

async function sendLevelCommand(
  transport: MobileRemoteTransport,
  path: string,
  command: Record<string, unknown>,
  changedKinds: ReadonlyArray<string>,
  refused: MobileThreadLevelChange,
): Promise<MobileThreadLevelChange> {
  try {
    const response = await transport.authenticatedFetch({
      method: "POST",
      path,
      body: JSON.stringify(command),
    });
    if (!response.ok) return refused;
    const answer: unknown = await response.json();
    return typeof answer === "object" &&
      answer !== null &&
      "kind" in answer &&
      typeof answer.kind === "string" &&
      changedKinds.includes(answer.kind)
      ? { status: "changed" }
      : refused;
  } catch {
    return refused;
  }
}

/** A Work or Code Project as the host lists it; a Chat Project has no level. */
export type MobileLevelProject = Extract<ProjectSummary, { readonly type: "work" | "code" }>;

/** The Project's own level for new threads; absent while it follows the default. */
export function mobileProjectLevel(project: MobileLevelProject): PermissionMode | undefined {
  return project.defaultPermissionMode;
}

const PROJECT_REFUSED: MobileThreadLevelChange = {
  status: "refused",
  message: "The host did not change this Project's mode.",
};

/**
 * Sets the level a Project's new threads start at; no level returns the
 * Project to the default. The Project's sandbox choice at Full access is sent
 * back as it was read, since the command returns an unmentioned choice to
 * Settings.
 */
export async function changeMobileProjectLevel(input: {
  readonly transport: MobileRemoteTransport;
  readonly project: MobileLevelProject;
  readonly level: PermissionMode | undefined;
}): Promise<MobileThreadLevelChange> {
  const { project, level } = input;
  if (project.type === "work" && level === "plan") return PROJECT_REFUSED;
  return sendLevelCommand(
    input.transport,
    "/api/projects/commands",
    {
      kind:
        project.type === "work"
          ? "change-work-project-permission-mode"
          : "change-code-project-permission-mode",
      projectId: project.id,
      expectedVersion: project.version,
      ...(level === undefined ? {} : { permissionMode: level }),
      ...(project.defaultFullAccessSandbox === undefined
        ? {}
        : { fullAccessSandbox: project.defaultFullAccessSandbox }),
    },
    ["code-project-access-changed", "work-project-permission-mode-changed"],
    PROJECT_REFUSED,
  );
}

/** The host's settings that hold the level new threads start at. */
export type MobileDefaultLevelSubject =
  | { readonly mode: "code"; readonly settings: CodeSettings }
  | { readonly mode: "work"; readonly settings: WorkSettings };

export function mobileDefaultLevel(subject: MobileDefaultLevelSubject): PermissionMode {
  return subject.mode === "work"
    ? permissionModeOfWorkAccess(subject.settings.defaultAccess)
    : permissionModeOf({
        executionPolicy: subject.settings.defaultExecutionPolicy,
        autoApprove: subject.settings.defaultAutoApprove,
      });
}

const DEFAULT_REFUSED: MobileThreadLevelChange = {
  status: "refused",
  message: "The host did not change the default mode.",
};

/** Sets the level new threads start at on this host, against the settings version read. */
export async function changeMobileDefaultLevel(input: {
  readonly transport: MobileRemoteTransport;
  readonly subject: MobileDefaultLevelSubject;
  readonly level: PermissionMode;
}): Promise<MobileThreadLevelChange> {
  const { subject } = input;
  if (subject.mode === "work") {
    const defaultAccess = workAccessOfPermissionMode(input.level);
    if (defaultAccess === undefined) return DEFAULT_REFUSED;
    const { settings } = subject;
    return sendLevelCommand(
      input.transport,
      "/api/work/threads/commands",
      {
        kind: "update-work-settings",
        expectedVersion: settings.version,
        // The command replaces the default model too, so the one read is sent back.
        ...(settings.defaultProviderInstanceId === undefined ||
        settings.defaultModelId === undefined
          ? {}
          : {
              defaultProviderInstanceId: settings.defaultProviderInstanceId,
              defaultModelId: settings.defaultModelId,
            }),
        defaultAccess,
      },
      ["settings-updated"],
      DEFAULT_REFUSED,
    );
  }
  const access = threadAccessOf(input.level);
  return sendLevelCommand(
    input.transport,
    "/api/code/commands",
    {
      kind: "update-code-settings",
      expectedVersion: subject.settings.version,
      defaultExecutionPolicy: access.executionPolicy,
      defaultPermissionPersistence: subject.settings.defaultPermissionPersistence,
      defaultAutoApprove: access.autoApprove,
    },
    ["settings-updated"],
    DEFAULT_REFUSED,
  );
}

/** What the phone shows beside a thread's own level: its Project and the host default. */
export interface MobileDefaultLevels {
  /** Absent when the host no longer lists the thread's Project. */
  readonly project: MobileLevelProject | undefined;
  /** Absent when an older host does not report its Work settings. */
  readonly defaults: MobileDefaultLevelSubject | undefined;
}

/** Reads the thread's Project and the mode's settings from the host; undefined when it refuses. */
export async function loadMobileDefaultLevels(input: {
  readonly transport: MobileRemoteTransport;
  readonly mode: "code" | "work";
  readonly projectId: string;
}): Promise<MobileDefaultLevels | undefined> {
  try {
    const [projects, settings] = await Promise.all([
      input.transport.authenticatedFetch({ method: "GET", path: "/api/projects/bootstrap" }),
      input.transport.authenticatedFetch({
        method: "GET",
        path: input.mode === "work" ? "/api/work/threads/bootstrap" : "/api/code/bootstrap",
      }),
    ]);
    if (!projects.ok || !settings.ok) return undefined;
    const project = decodeHostAnswer(ProjectBootstrap)(await projects.json()).active.find(
      (entry): entry is MobileLevelProject =>
        String(entry.id) === input.projectId && entry.type === input.mode,
    );
    if (input.mode === "work") {
      const work = decodeHostAnswer(WorkThreadBootstrap)(await settings.json()).settings;
      return {
        project,
        defaults: work === undefined ? undefined : { mode: "work", settings: work },
      };
    }
    const code = decodeHostAnswer(CodeBootstrap)(await settings.json()).settings;
    return { project, defaults: { mode: "code", settings: code } };
  } catch {
    return undefined;
  }
}
