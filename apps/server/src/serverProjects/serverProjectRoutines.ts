import type { AutomationSourceBranch } from "../automation/automationCodeDispatchPort";
import type { AutomationServerProjectBinding } from "../automation/resolveAutomationAuthorityLiveFacts";
import type { AutomationServerReach } from "../automation/automationWorkDispatchPort";
import type { ServerConnection } from "./serverConnection";
import { serverCodeCheckout } from "./serverProjectThreads";
import type { ServerProjectStore } from "./serverProjectStore";
import { serverWorkBindingRevisionId } from "./serverWorkThreads";
import { serverCurrentBranch } from "./serverWorktrees";

/**
 * Routines in a server Project. Canonical: docs/design/server-projects.md
 * § Routines.
 *
 * This host's scheduler runs the routine and every check stays here; the
 * thread it starts is an ordinary thread in the Project, whose hands are on
 * the server as a person-started thread's are.
 */

const REACH_TIMEOUT_MS = 20_000;
const SERVER_NOT_REGISTERED =
  "This routine's server is no longer registered in Settings › Permissions › Servers, so nothing ran.";

/**
 * The binding a routine in this server Project revalidates against: the one
 * its Project derives now, whether its server is still registered, or that
 * the person removed it. Undefined for an id no server Project ever had.
 */
export function serverRoutineBinding(
  store: Pick<ServerProjectStore, "project" | "addressOf" | "wasRemoved">,
  projectId: string,
): AutomationServerProjectBinding | undefined {
  const project = store.project(projectId);
  if (project === undefined) return store.wasRemoved(projectId) ? { kind: "removed" } : undefined;
  const serverRegistered = store.addressOf(projectId).kind === "address";
  if (project.mode === "work") {
    return {
      kind: "bound",
      mode: "work",
      serverRegistered,
      bindingRevisionId: String(serverWorkBindingRevisionId(project)),
    };
  }
  const derived = serverCodeCheckout(project);
  return {
    kind: "bound",
    mode: "code",
    serverRegistered,
    bindingRevisionId: String(derived.bindingRevisionId),
    repositoryId: String(derived.checkout.repositoryId),
    checkoutId: String(derived.checkout.id),
  };
}

/**
 * Whether a server Project's folder answers now. A routine's Work thread is
 * created on this host alone, so this is asked first: a run that cannot reach
 * its server fails, naming the server, and nothing runs anywhere.
 */
export async function reachServerProject(
  options: {
    readonly store: Pick<ServerProjectStore, "project" | "addressOf">;
    readonly connection: Pick<ServerConnection, "run">;
  },
  projectId: string,
): Promise<AutomationServerReach> {
  const project = options.store.project(projectId);
  if (project === undefined) return { kind: "not-on-a-server" };
  const address = options.store.addressOf(projectId);
  if (address.kind !== "address") {
    return {
      kind: "unreachable",
      message: SERVER_NOT_REGISTERED,
    };
  }
  const call = await options.connection.run(address.server, {
    script: `exec 2>/dev/null; cd -- "$1"`,
    args: [project.folder],
    timeoutMs: REACH_TIMEOUT_MS,
    maxOutputBytes: 1_024,
  });
  if (call.status === "ran" && call.exitCode === 0) return { kind: "reachable" };
  if (call.status === "ran") {
    return {
      kind: "unreachable",
      message: `The Project's folder is no longer on ${address.server.alias}, so this routine ran nothing.`,
    };
  }
  return {
    kind: "unreachable",
    message: `${address.server.alias} could not be reached, so this routine ran nothing.`,
  };
}

/**
 * The branch a Code routine's worktree on the server starts from, read there
 * now: the run's first contact with the server, so one that cannot be reached
 * creates no thread and runs nothing. Undefined for a Project not on a server.
 */
export async function serverRoutineSourceBranch(
  options: {
    readonly store: Pick<ServerProjectStore, "codeProject" | "addressOf" | "serverOf">;
    readonly connection: Pick<ServerConnection, "run">;
  },
  projectId: string,
): Promise<AutomationSourceBranch | undefined> {
  const current = await serverCurrentBranch(options, projectId);
  if (current === undefined) return undefined;
  const alias = options.store.serverOf(projectId)?.alias ?? "The Project's server";
  switch (current.kind) {
    case "branch":
      return current;
    case "server-not-registered":
      return { kind: "unavailable", message: SERVER_NOT_REGISTERED };
    case "unreachable":
      return {
        kind: "unavailable",
        message: `${alias} could not be reached, so this routine ran nothing.`,
      };
    case "no-branch":
      return {
        kind: "unavailable",
        message: `The Project's folder on ${alias} has no branch checked out, so this routine's worktree has nothing to start from.`,
      };
  }
}
