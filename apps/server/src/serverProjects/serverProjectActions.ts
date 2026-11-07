import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Schema } from "effect";
import {
  AggregateVersion,
  type CodeThreadId,
  type CodeCheckoutId,
  type ProjectId,
  type ProviderExecutionPolicy,
  type WindowId,
  type WorkThreadId,
} from "@octant/contracts";
import type { ServerProject } from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import type {
  ProjectActionPlacementRequest,
  ProjectTerminalServiceOptions,
  ServerProjectActionPlacement,
} from "../code/projectTerminalService";
import {
  MAX_ACTION_SOURCE_BYTES,
  projectActionSuggestionsFromSources,
} from "../code/projectActionSuggestions";
import { ServerFileSystem, RESOLVE_INSIDE, withProtectedPaths } from "./serverFiles";
import { serverRemoteCommand, type ServerConnection } from "./serverConnection";
import { serverCodeCheckout } from "./serverProjectThreads";
import { serverWorkBindingRevisionId } from "./serverWorkThreads";
import type { ServerProjectStore } from "./serverProjectStore";

const DIRECTORY_ID = `stat -Lc '%d:%i' . 2>/dev/null || stat -f '%d:%i' . 2>/dev/null`;
const GIT_READ = "export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0";
const PLACE_SCRIPT = `${RESOLVE_INSIDE}
cd -P -- "$r" || exit 2
identity=$(${DIRECTORY_ID}) || exit 2
${GIT_READ}
head=$(git rev-parse --verify HEAD 2>/dev/null) || head=
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=
printf '%s\\0%s\\0%s\\0' "$identity" "$head" "$branch"`;

// The shell holds its checked cwd while the command runs. An SSH exit255 is
// reserved for transport loss, so a command's own255 becomes254 as in calls.
const RUN_SCRIPT = `refuse() { printf '%s\\n' 'Octant refused a changed server action placement.'; exit 126; }
cd -P -- "$1" || refuse
[ "$(pwd -P)" = "$1" ] || refuse
[ "$(${DIRECTORY_ID})" = "$2" ] || refuse
${GIT_READ}
head=$(git rev-parse --verify HEAD 2>/dev/null) || head=
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=
[ "$head" = "$3" ] && [ "$branch" = "$4" ] || refuse
if [ "$6" = closed ]; then sh -c "$5" </dev/null; else sh -c "$5"; fi
status=$?; [ "$status" -eq 255 ] && status=254
exit "$status"`;

export interface ServerActionTask {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly root: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly authorityRevision: string;
  readonly current: () => boolean;
}
export interface ServerWorkActionTask {
  readonly workThreadId: WorkThreadId;
  readonly root: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly authorityRevision: string;
  readonly current: () => boolean;
}

export function createServerProjectActions(options: {
  readonly store: Pick<ServerProjectStore, "project" | "serverOf">;
  readonly connection: Pick<ServerConnection, "run" | "loginCommand">;
  readonly task: (
    windowId: WindowId,
    projectId: ProjectId,
    thread: NonNullable<ProjectActionPlacementRequest["thread"]>,
  ) => Promise<ServerActionTask | undefined>;
  readonly workTask?: (
    windowId: WindowId,
    projectId: ProjectId,
    threadId: WorkThreadId,
  ) => Promise<ServerWorkActionTask | undefined>;
}): Pick<ProjectTerminalServiceOptions, "placeServerAction" | "suggestServerActions"> {
  const serverRevision = (project: ServerProject, server: ShieldServer) =>
    JSON.stringify({
      projectId: project.id,
      serverId: project.serverId,
      folder: project.folder,
      boundAt: project.boundAt,
      actions: project.actions,
      actionsVersion: project.actionsVersion,
      server,
    });
  const current = (project: ServerProject, server: ShieldServer) => {
    const fresh = options.store.project(String(project.id));
    const registered = options.store.serverOf(String(project.id));
    return (
      fresh !== undefined &&
      registered !== undefined &&
      serverRevision(fresh, registered) === serverRevision(project, server)
    );
  };
  return {
    suggestServerActions: async (projectId) => {
      const project = options.store.project(String(projectId));
      const server = options.store.serverOf(String(projectId));
      if (project === undefined || server === undefined) return undefined;
      const files = new ServerFileSystem({
        connection: options.connection,
        root: project.folder,
        maxFileBytes: MAX_ACTION_SOURCE_BYTES,
        server: () => (current(project, server) ? server : undefined),
      });
      const [manifest, makefile, directory] = await Promise.all([
        files.read({ path: "package.json" }),
        files.read({ path: "Makefile" }),
        files.read({ path: "." }),
      ]);
      if (!current(project, server)) return undefined;
      const text = (read: typeof manifest) =>
        read.kind === "file" && !read.bounds.truncated ? read.lines.join("\n") : undefined;
      const names =
        directory.kind === "directory"
          ? directory.entries.filter((row) => row.kind === "file").map((row) => row.name)
          : [];
      const manager =
        names.includes("bun.lock") || names.includes("bun.lockb")
          ? "bun"
          : names.includes("pnpm-lock.yaml")
            ? "pnpm"
            : names.includes("yarn.lock")
              ? "yarn"
              : "npm";
      return projectActionSuggestionsFromSources({
        manifest: text(manifest),
        makefile: text(makefile),
        manager,
      });
    },
    placeServerAction: async (windowId, command) => {
      const project = options.store.project(String(command.projectId));
      const server = options.store.serverOf(String(command.projectId));
      if (project === undefined || server === undefined)
        return refused("This server Project is unavailable.");
      const action = project.actions?.find((row) => row.id === command.actionId);
      if (action === undefined || action.preparesWorktrees === true)
        return refused("This server Project has no such runnable saved action.");
      if (command.thread !== undefined && command.workThreadId !== undefined)
        return refused("Choose one task for this action.");
      if (
        project.mode === "work" ? command.thread !== undefined : command.workThreadId !== undefined
      )
        return refused("This server action cannot use a task from another mode.");
      const task =
        command.workThreadId !== undefined
          ? await options.workTask?.(windowId, project.id, command.workThreadId)
          : command.thread === undefined
            ? undefined
            : await options.task(windowId, project.id, command.thread);
      if (
        (command.thread !== undefined || command.workThreadId !== undefined) &&
        (task === undefined || !task.current())
      )
        return refused("This server checkout or task authority changed.");
      if (command.kind === "start-action" && task?.executionPolicy === "plan")
        return refused("Plan cannot launch a server action.");
      const root =
        command.folder === undefined
          ? (task?.root ?? project.folder)
          : command.folder === project.folder || command.folder === task?.root
            ? command.folder
            : undefined;
      if (root === undefined)
        return refused("That folder is not this server Project or its active checkout.");
      const call = await options.connection.run(server, {
        script: withProtectedPaths(PLACE_SCRIPT),
        args: [posix.join(root, action.directory), root],
        timeoutMs: 20000,
        maxOutputBytes: 8192,
      });
      if (call.status !== "ran" || call.exitCode !== 0 || call.truncated)
        return refused(
          "The action folder on the server could not be checked; nothing was read locally.",
        );
      const parts = call.output.toString("utf8").split("\0");
      const [folder, identity, head, branch, tail] = parts;
      if (
        folder === undefined ||
        identity === undefined ||
        !/^\d+:\d+$/.test(identity) ||
        head === undefined ||
        (head !== "" && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head)) ||
        branch === undefined ||
        branch.length > 256 ||
        tail !== "" ||
        parts.length !== 5 ||
        !current(project, server) ||
        task?.current() === false ||
        (command.thread?.head !== undefined && command.thread.head !== head)
      )
        return refused("This server checkout, registry or saved action changed. Review it again.");
      const projectVersion = Schema.decodeUnknownSync(AggregateVersion)(
        project.actionsVersion ?? 0,
      );
      const revision = `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            binding: serverRevision(project, server),
            folder,
            identity,
            head,
            branch,
            task:
              task === undefined
                ? undefined
                : {
                    ...("workThreadId" in task
                      ? { workThreadId: task.workThreadId }
                      : { threadId: task.threadId, checkoutId: task.checkoutId }),
                    authority: task.authorityRevision,
                  },
          }),
        )
        .digest("hex")}`;
      const receipt: ServerProjectActionPlacement["receipt"] = {
        actionId: action.id,
        name: action.name,
        folder,
        ...(branch === "" ? {} : { branch }),
        ...(task === undefined
          ? {}
          : "workThreadId" in task
            ? { workThreadId: task.workThreadId }
            : {
                thread: {
                  threadId: task.threadId,
                  checkoutId: task.checkoutId,
                  ...(head === "" ? {} : { head }),
                },
              }),
        server: {
          serverId: server.serverId,
          alias: server.alias,
          user: server.user,
          profile: server.profile,
          placementRevision: revision,
          confinement: "none",
          ...(task === undefined ? {} : { taskExecutionPolicy: task.executionPolicy }),
        },
      };
      return {
        kind: "placed-on-server",
        action,
        projectVersion,
        receipt,
        bindingRevisionId:
          project.mode === "work"
            ? serverWorkBindingRevisionId(project)
            : serverCodeCheckout(project).bindingRevisionId,
        current: () => current(project, server) && task?.current() !== false,
        login: options.connection.loginCommand(
          server,
          serverRemoteCommand(RUN_SCRIPT, [
            folder,
            identity,
            head,
            branch,
            action.command,
            project.mode === "work" ? "closed" : "terminal",
          ]),
        ),
      };
    },
  };
}

function refused(
  message: string,
): Extract<
  import("@octant/contracts").ProjectTerminalResult,
  { kind: "project-terminal-refused" }
> {
  return { kind: "project-terminal-refused", reason: "authority-revoked", message };
}
