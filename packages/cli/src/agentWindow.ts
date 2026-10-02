import { randomUUID } from "node:crypto";
import { refusalMessage, type HostRefusal } from "./agentHost";
import type { OpenedLocalControlSession } from "./localControl";

/**
 * Puts a Work or Code thread in front of this CLI's window, the way opening it
 * in the app does.
 *
 * The host authorizes Code checkouts, goals, and harness approvals against
 * what a window has open, never against a scope the caller names: a window in
 * Code on Project A may prepare A's checkout, and one showing a thread may
 * answer that thread's approvals. A terminal client is a window like any
 * other, so it opens the Project first and then the thread itself.
 */
export async function openAgentWindow(
  session: OpenedLocalControlSession,
  target: {
    readonly mode: "work" | "code";
    readonly projectId: string;
    readonly projectName: string;
    readonly thread?: { readonly id: string; readonly title: string } | undefined;
  },
): Promise<HostRefusal | { readonly kind: "opened" }> {
  // A window keeps its workspace once registered; registering again would
  // start it over, so only a window the host does not know yet registers.
  const existing = await session.send({ path: "/api/shell/bootstrap", method: "GET" });
  if (existing.status !== 200) {
    const registered = await session.send({ path: "/api/shell/bootstrap", method: "POST" });
    if (registered.status !== 200) {
      return {
        kind: "refused",
        message: refusalMessage(
          registered,
          "This terminal could not open a workspace on the host.",
        ),
      };
    }
  }
  const surfaces = [
    {
      kind: "project",
      id: randomUUID(),
      projectId: target.projectId,
      mode: target.mode,
      title: target.projectName,
    },
    ...(target.thread === undefined
      ? []
      : [
          target.mode === "code"
            ? {
                kind: "code-overview",
                id: randomUUID(),
                threadId: target.thread.id,
                mode: "code",
                title: target.thread.title,
              }
            : {
                kind: "work-thread",
                id: randomUUID(),
                threadId: target.thread.id,
                mode: "work",
                title: target.thread.title,
              },
        ]),
  ];
  for (const surface of surfaces) {
    const current = await session.send({ path: "/api/shell/bootstrap", method: "GET" });
    const version = (current.body as { readonly workspaceVersion?: unknown } | undefined)
      ?.workspaceVersion;
    if (current.status !== 200 || typeof version !== "number") {
      return {
        kind: "refused",
        message: refusalMessage(current, "This terminal could not read its workspace."),
      };
    }
    const opened = await session.send({
      path: "/api/shell/commands",
      method: "POST",
      body: {
        kind: "apply-workspace-operation",
        windowId: session.windowId,
        expectedVersion: version,
        operation: { kind: "switch-project-surface", mode: target.mode, surface },
      },
    });
    if (opened.status !== 200) {
      return {
        kind: "refused",
        message: refusalMessage(opened, `The host would not open ${target.projectName} here.`),
      };
    }
  }
  return { kind: "opened" };
}
