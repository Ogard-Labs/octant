import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { decodeWindowId, decodeBindingRevisionId } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { decodeWorkThread } from "@octant/contracts/work-threads";
import { ServerProject } from "@octant/contracts/server-projects";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { serverWorkBindingRevisionId } from "./serverWorkThreads";
import { createServerWorkActionTask } from "./serverWorkProjectActions";

it("binds Work action authority to the live window's exact server task and invalidates changed access, model, binding and completion", async () => {
  const project = Schema.decodeUnknownSync(ServerProject)({
    id: randomUUID(),
    name: "Notes",
    serverId: randomUUID(),
    folder: "/srv/notes",
    mode: "work",
    boundAt: "2026-11-07T10:00:00.000Z",
  });
  const initial = decodeWorkThread({
    id: randomUUID(),
    projectId: project.id,
    bindingRevisionId: serverWorkBindingRevisionId(project),
    title: "Task",
    lifecycle: "active",
    providerInstanceId: randomUUID(),
    modelId: "synthetic",
    access: "ask-first",
    workingDirectory: "reports",
    version: 1,
    createdAt: "2026-11-07T10:00:00.000Z",
    updatedAt: "2026-11-07T10:00:00.000Z",
  });
  let thread = initial;
  const windowId = decodeWindowId(randomUUID());
  const empty = defaultWindowWorkspace(windowId);
  let workspace = {
    ...empty,
    contextByMode: {
      ...empty.contextByMode,
      work: contextKeyForProject("work", LOCAL_HOST_ID, project.id, project.folder),
    },
  };
  let live = true;
  let enabled = true;
  const resolve = createServerWorkActionTask({
    store: { workProject: (id) => (id === String(project.id) ? project : undefined) },
    readThread: (id) => (id === thread.id ? thread : undefined),
    workspace: (id) => (id === windowId ? workspace : undefined),
    isWindowLive: (id) => id === windowId && live,
    workEnabled: () => enabled,
  });
  const admitted = await resolve(windowId, project.id, thread.id);
  expect(admitted).toMatchObject({
    workThreadId: thread.id,
    root: "/srv/notes/reports",
    executionPolicy: "approval-gated",
  });
  if (admitted === undefined) throw Error("Expected reviewed task authority");
  thread = { ...thread, title: "Renamed task" };
  expect(admitted.current()).toBe(true);
  thread = { ...thread, access: "full-access" };
  expect(admitted.current()).toBe(false);
  thread = initial;
  for (const changed of [
    decodeWorkThread({ ...initial, modelId: "changed" }),
    { ...initial, bindingRevisionId: decodeBindingRevisionId(randomUUID()) },
    decodeWorkThread({ ...initial, completedAt: "2026-11-07T11:00:00.000Z" }),
  ]) {
    thread = changed;
    expect(admitted.current()).toBe(false);
  }
  thread = initial;
  live = false;
  expect(await resolve(windowId, project.id, thread.id)).toBeUndefined();
  live = true;
  enabled = false;
  expect(await resolve(windowId, project.id, thread.id)).toBeUndefined();
  enabled = true;
  workspace = empty;
  expect(await resolve(windowId, project.id, thread.id)).toBeUndefined();
});
