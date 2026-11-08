import {
  CodeBootstrap,
  WorkThreadBootstrap,
  type PermissionMode,
  decodeHostAnswer,
} from "@octant/contracts";
import { threadAccessOf, workAccessOfPermissionMode } from "@octant/domain";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

export type SettingsCliCommand = {
  readonly action: "access";
  readonly mode: PermissionMode;
  /** The Work default instead of the Code default. */
  readonly work: boolean;
};

const ACCESS_MODES: ReadonlyArray<string> = [
  "ask-first",
  "accept-edits",
  "auto",
  "plan",
  "full-access",
];

function isPermissionMode(value: string): value is PermissionMode {
  return ACCESS_MODES.includes(value);
}

export function resolveSettingsCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): SettingsCliCommand | undefined {
  const [action, mode] = positional;
  if (action !== "access" || positional.length !== 2 || mode === undefined) return undefined;
  if (Object.keys(flags).some((flag) => flag !== "work")) return undefined;
  if (!isPermissionMode(mode)) return undefined;
  const work = flags.work === true;
  // Work has no Plan overlay, so the Code-only mode is refused up front.
  if (work && mode === "plan") return undefined;
  return { action: "access", mode, work };
}

export async function runSettingsCliCommand(input: {
  readonly command: SettingsCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}): Promise<number> {
  const { command, session, stdout, stderr } = input;
  if (!command.work) {
    const bootstrap = await session.send({ path: "/api/code/bootstrap", method: "GET" });
    if (bootstrap.status !== 200) {
      stderr.write(`${failureMessage(bootstrap, "Code settings are unavailable on this host.")}\n`);
      return 1;
    }
    const settings = decodeHostAnswer(CodeBootstrap)(bootstrap.body).settings;
    const access = threadAccessOf(command.mode);
    const executed = await session.send({
      path: "/api/code/commands",
      method: "POST",
      body: {
        kind: "update-code-settings",
        expectedVersion: settings.version,
        defaultExecutionPolicy: access.executionPolicy,
        defaultPermissionPersistence: settings.defaultPermissionPersistence,
        defaultAutoApprove: access.autoApprove,
      },
    });
    if (executed.status !== 200) {
      stderr.write(`${failureMessage(executed, "Octant refused this settings change.")}\n`);
      return 1;
    }
    stdout.write(
      command.mode === "full-access"
        ? "New Code threads now start at Full access by default (remembered per Project where one overrides the global default).\n"
        : `New Code threads now start at ${command.mode} by default.\n`,
    );
    return 0;
  }
  const bootstrap = await session.send({ path: "/api/work/threads/bootstrap", method: "GET" });
  if (bootstrap.status !== 200) {
    stderr.write(`${failureMessage(bootstrap, "Work settings are unavailable on this host.")}\n`);
    return 1;
  }
  const settings = decodeHostAnswer(WorkThreadBootstrap)(bootstrap.body).settings;
  if (settings === undefined) {
    stderr.write("Work settings are unavailable on this host.\n");
    return 1;
  }
  const access = workAccessOfPermissionMode(command.mode);
  if (access === undefined) {
    stderr.write("--access plan is not a Work mode; Work has no Plan overlay.\n");
    return 1;
  }
  const executed = await session.send({
    path: "/api/work/threads/commands",
    method: "POST",
    body: {
      kind: "update-work-settings",
      expectedVersion: settings.version,
      defaultAccess: access,
    },
  });
  if (executed.status !== 200) {
    stderr.write(`${failureMessage(executed, "Octant refused this settings change.")}\n`);
    return 1;
  }
  stdout.write(`New Work threads now start at ${command.mode} by default.\n`);
  return 0;
}
