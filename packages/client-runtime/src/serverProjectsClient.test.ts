import { expect, it, vi } from "vitest";
import { createServerProjectsClient } from "./serverProjectsClient";
import { decodeServerProjectsCommand } from "@octant/contracts/server-projects";
const projectId = "11111111-1111-4111-8111-111111111111";
it("sends a versioned server action save once and preserves a stale-list refusal", async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      {
        kind: "server-projects-refused",
        reason: "actions-changed",
        message: "Review the current actions.",
      },
      { status: 409 },
    ),
  );
  const client = createServerProjectsClient({
    baseUrl: "http://127.0.0.1:1234",
    windowCapability: "private-window-token",
    fetch,
  });
  const command = decodeServerProjectsCommand({
    kind: "set-server-project-actions",
    projectId,
    expectedVersion: 3,
    actions: [],
  });
  expect(await client.command(command)).toMatchObject({
    kind: "server-projects-refused",
    reason: "actions-changed",
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:1234/api/server-projects",
    expect.objectContaining({
      body: JSON.stringify(command),
      headers: expect.objectContaining({ "x-octant-window-capability": "private-window-token" }),
    }),
  );
});
it("authenticates preview requests and returns a refused start without retrying", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ kind: "refused", reason: "already-owned" }, { status: 409 }),
  );
  const client = createServerProjectsClient({
    baseUrl: "http://127.0.0.1:1234",
    windowCapability: "private-window-token",
    fetch,
  });
  if (client.previewCommand === undefined) throw new Error("missing preview client");
  expect(await client.previewCommand({ kind: "stop", projectId: projectId as never })).toEqual({
    kind: "refused",
    reason: "already-owned",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:1234/api/server-project-preview",
    expect.objectContaining({
      headers: expect.objectContaining({ "x-octant-window-capability": "private-window-token" }),
    }),
  );
});
it("rejects a malformed preview status instead of treating an unsafe endpoint as ready", async () => {
  const client = createServerProjectsClient({
    baseUrl: "http://127.0.0.1:1234",
    windowCapability: "private-window-token",
    fetch: async () =>
      Response.json({
        view: {
          projectId,
          remotePort: 5173,
          localPort: 0,
          endpoint: "http://127.0.0.1:0",
          status: "listening",
        },
      }),
  });
  if (client.previewRead === undefined) throw new Error("missing preview client");
  await expect(client.previewRead(projectId)).rejects.toThrow();
});
it("authenticates a single cancellable read-only setup probe without retrying", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ status: "disconnected", reason: "changed-identity" }),
  );
  const client = createServerProjectsClient({
    baseUrl: "http://127.0.0.1:1234",
    windowCapability: "window",
    fetch,
  });
  if (client.check === undefined) throw new Error("missing check client");
  const abort = new AbortController();
  expect(
    await client.check({ serverId: projectId as never, runtime: "octant-harness" }, abort.signal),
  ).toEqual({ status: "disconnected", reason: "changed-identity" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:1234/api/remote-setup-check",
    expect.objectContaining({
      signal: abort.signal,
      headers: expect.objectContaining({ "x-octant-window-capability": "window" }),
    }),
  );
});
