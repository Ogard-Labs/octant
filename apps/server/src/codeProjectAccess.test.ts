import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { defaultWindowWorkspace, contextKeyForProject } from "@octant/domain";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { Schema } from "effect";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { describe, expect, it } from "vitest";
import { createAuthenticatedProductDispatch } from "./authenticatedProductRoutes";
import { resolvePrincipalRouteContext } from "./principalRouteContext";
import { CodeProjectAccess } from "./codeProjectAccess";

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
