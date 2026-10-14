import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { defaultWindowWorkspace, contextKeyForProject } from "@octant/domain";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { Schema } from "effect";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { describe, expect, it } from "vitest";
import { createAuthenticatedProductDispatch } from "./authenticatedProductRoutes";
import { resolvePrincipalRouteContext } from "./principalRouteContext";
import { CodeProjectAccess } from "./codeProjectAccess";
import { ROUTINE_HOST_SCOPE_ID } from "./routineHostScope";

const scopeId = decodeWindowId("00000000-0000-4000-8000-00000000c001");
const projectId = decodeProjectId("00000000-0000-4000-8000-00000000c010");
const principal = {
  kind: "remote-device" as const,
  deviceId: Schema.decodeUnknownSync(DeviceId)(String(scopeId)),
  hostId: Schema.decodeUnknownSync(StableHostId)("00000000-0000-4000-8000-00000000c002"),
  credentialGeneration: 1,
  origin: "https://octant.example",
  protocolVersion: 1,
  capabilityDigest: "b".repeat(64),
  sessionId: Schema.decodeUnknownSync(RemoteSessionId)("00000000-0000-4000-8000-00000000c003"),
};

it("allows an authenticated device to reach an active Code Project without a desktop workspace", async () => {
  const access = new CodeProjectAccess({
    readWorkspace: () => undefined,
    hasActiveCodeProject: (id) => id === projectId,
    isWindowLive: () => true,
  });
  const dispatch = createAuthenticatedProductDispatch({
    dispatch: (_request, context) =>
      access.run(context, async () => {
        await Promise.resolve();
        return Response.json({ allowed: access.canAccessProject(scopeId, projectId) });
      }),
  });
  const response = await dispatch({
    principal,
    request: new Request("https://octant.example/api/code/bootstrap"),
  });
  expect(await response?.json()).toEqual({ allowed: true });
  expect(access.canAccessProject(scopeId, projectId)).toBe(false);
});

describe("remote Code authority lifetime", () => {
  it("refuses other scopes, inactive Projects, cancelled requests, and deferred work after dispatch", async () => {
    let active = true;
    const access = new CodeProjectAccess({
      readWorkspace: () => undefined,
      hasActiveCodeProject: () => active,
      isWindowLive: () => true,
    });
    const controller = new AbortController();
    const context = resolvePrincipalRouteContext({
      request: new Request("https://octant.example/api/code/bootstrap"),
      principal,
      abortSignal: controller.signal,
    });
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deferred: Promise<boolean> | undefined;
    await access.run(context, async () => {
      expect(
        access.canAccessProject(decodeWindowId("00000000-0000-4000-8000-00000000c004"), projectId),
      ).toBe(false);
      active = false;
      expect(access.canAccessProject(scopeId, projectId)).toBe(false);
      active = true;
      controller.abort();
      expect(access.canAccessProject(scopeId, projectId)).toBe(false);
    });
    const freshContext = resolvePrincipalRouteContext({
      request: new Request("https://octant.example/api/code/bootstrap"),
      principal,
    });
    await access.run(freshContext, async () => {
      expect(access.canAccessProject(scopeId, projectId)).toBe(true);
      deferred = waiting.then(() => access.canAccessProject(scopeId, projectId));
    });
    release();
    expect(await deferred).toBe(false);
  });
});

it("keeps concurrent local window checks isolated from a pending remote request", async () => {
  const workspace = defaultWindowWorkspace(scopeId);
  const otherProject = decodeProjectId("00000000-0000-4000-8000-00000000c011");
  const access = new CodeProjectAccess({
    readWorkspace: () => ({
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: contextKeyForProject("code", LOCAL_HOST_ID, projectId, "/repo"),
      },
    }),
    hasActiveCodeProject: () => true,
    isWindowLive: () => true,
  });
  const context = resolvePrincipalRouteContext({
    request: new Request("https://octant.example/api/code/bootstrap"),
    principal,
  });
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remote = access.run(context, async () => {
    expect(access.canAccessProject(scopeId, otherProject)).toBe(true);
    await waiting;
    expect(access.canAccessProject(scopeId, otherProject)).toBe(true);
  });
  expect(access.canAccessProject(scopeId, projectId)).toBe(true);
  expect(access.canAccessProject(scopeId, otherProject)).toBe(false);
  release();
  await remote;
  expect(access.canAccessProject(scopeId, otherProject)).toBe(false);
});

it("lets a routine reach its active Code Project with no window bound to it, and nothing inactive", async () => {
  const inactive = decodeProjectId("00000000-0000-4000-8000-00000000c012");
  const access = new CodeProjectAccess({
    readWorkspace: () => undefined,
    hasActiveCodeProject: (id) => id === projectId,
    isWindowLive: () => true,
  });
  expect(access.canAccessProject(ROUTINE_HOST_SCOPE_ID, projectId)).toBe(true);
  expect(access.canAccessProject(ROUTINE_HOST_SCOPE_ID, inactive)).toBe(false);
  // A routine started from a person's run-now request still runs as the host.
  const context = resolvePrincipalRouteContext({
    request: new Request("https://octant.example/api/automations/run"),
    principal,
  });
  await access.run(context, async () => {
    expect(access.canAccessProject(ROUTINE_HOST_SCOPE_ID, projectId)).toBe(true);
  });
  // Any other unbound scope still reaches nothing.
  expect(access.canAccessProject(scopeId, projectId)).toBe(false);
});

it("judges work that outlives its request on the window's standing binding, never on the request", async () => {
  const otherProject = decodeProjectId("00000000-0000-4000-8000-00000000c013");
  const workspace = defaultWindowWorkspace(scopeId);
  const access = new CodeProjectAccess({
    readWorkspace: () => ({
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: contextKeyForProject("code", LOCAL_HOST_ID, projectId, "/repo"),
      },
    }),
    hasActiveCodeProject: () => true,
    isWindowLive: () => true,
  });
  const context = resolvePrincipalRouteContext({
    request: new Request("https://octant.example/api/code/execute"),
    principal,
  });
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deferred: Promise<ReadonlyArray<boolean>> | undefined;
  await access.run(context, async () => {
    deferred = waiting.then(() => [
      access.canAccessProject(scopeId, projectId),
      access.standingAuthority(() => access.canAccessProject(scopeId, projectId)),
      // The device's request reached any active Project; standing does not.
      access.standingAuthority(() => access.canAccessProject(scopeId, otherProject)),
    ]);
  });
  release();
  expect(await deferred).toEqual([false, true, false]);
});

it("refuses a closed window on its standing authority until the same window is live again, and leaves a routine alone", () => {
  const workspace = defaultWindowWorkspace(scopeId);
  let live = true;
  const access = new CodeProjectAccess({
    readWorkspace: () => ({
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: contextKeyForProject("code", LOCAL_HOST_ID, projectId, "/repo"),
      },
    }),
    hasActiveCodeProject: () => true,
    isWindowLive: () => live,
  });
  const standing = () =>
    access.standingAuthority(() => access.canAccessProject(scopeId, projectId));
  expect(standing()).toBe(true);
  // Closing revokes the window; its persisted workspace stays behind.
  live = false;
  expect(standing()).toBe(false);
  expect(
    access.standingAuthority(() => access.canAccessProject(ROUTINE_HOST_SCOPE_ID, projectId)),
  ).toBe(true);
  // The primary window reopens under the same id.
  live = true;
  expect(standing()).toBe(true);
});
