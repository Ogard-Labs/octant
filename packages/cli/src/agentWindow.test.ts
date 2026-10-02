import { describe, expect, it } from "vitest";
import { pickAgentModel } from "./agentThread";
import { openAgentWindow } from "./agentWindow";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

function recordingSession(registered: boolean) {
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  }> = [];
  let version = 1;
  let known = registered;
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "window-1",
    send: async (request: LocalControlRequest) => {
      requests.push({
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (request.path === "/api/shell/bootstrap") {
        if (request.method === "POST") known = true;
        return known
          ? { status: 200, body: { workspaceVersion: version } }
          : { status: 400, body: { message: "Shell bootstrap window is not registered." } };
      }
      version += 1;
      return { status: 200, body: { kind: "workspace-replaced" } };
    },
    close: async () => undefined,
  };
  return { session, requests };
}

describe("opening a thread in the terminal's window", () => {
  it("registers the window once, then opens the Project before the thread", async () => {
    const { session, requests } = recordingSession(false);
    const opened = await openAgentWindow(session, {
      mode: "code",
      projectId: "project-1",
      projectName: "parser",
      thread: { id: "thread-1", title: "Trailing commas" },
    });
    expect(opened).toEqual({ kind: "opened" });
    expect(
      requests.filter(
        (request) => request.method === "POST" && request.path === "/api/shell/bootstrap",
      ),
    ).toHaveLength(1);
    const surfaces = requests
      .filter((request) => request.path === "/api/shell/commands")
      .map(
        (request) =>
          (request.body as { operation: { surface: { kind: string } } }).operation.surface,
      );
    expect(surfaces.map((surface) => surface.kind)).toEqual(["project", "code-overview"]);
    expect(surfaces[1]).toMatchObject({ threadId: "thread-1", mode: "code" });
  });

  it("keeps a workspace the window already has instead of registering it again", async () => {
    const { session, requests } = recordingSession(true);
    await openAgentWindow(session, { mode: "work", projectId: "p", projectName: "notes" });
    expect(
      requests.some(
        (request) => request.method === "POST" && request.path === "/api/shell/bootstrap",
      ),
    ).toBe(false);
  });

  it("says plainly when the host will not open the Project here", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "window-1",
      send: async (request) =>
        request.path === "/api/shell/bootstrap"
          ? { status: 200, body: { workspaceVersion: 1 } }
          : { status: 403, body: { message: "Project is unavailable." } },
      close: async () => undefined,
    };
    const opened = await openAgentWindow(session, {
      mode: "code",
      projectId: "p",
      projectName: "parser",
    });
    expect(opened).toMatchObject({ kind: "refused" });
  });
});

describe("choosing a model with --model", () => {
  const models = [
    { endpoint: "LM Studio", modelId: "gemma-4-12b" },
    { endpoint: "Gateway", modelId: "frontier" },
    { endpoint: "Backup", modelId: "frontier" },
  ];

  it("finds a model by id, or by endpoint/model when the id is offered twice", () => {
    expect(pickAgentModel(models, "Gemma-4-12B")).toBe(models[0]);
    expect(pickAgentModel(models, "frontier")).toBeUndefined();
    expect(pickAgentModel(models, "backup/frontier")).toBe(models[2]);
    expect(pickAgentModel(models, "missing")).toBeUndefined();
  });
});
