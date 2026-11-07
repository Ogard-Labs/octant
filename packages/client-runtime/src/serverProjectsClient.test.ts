import { expect, it, vi } from "vitest";
import { createServerProjectsClient } from "./serverProjectsClient";
const projectId = "11111111-1111-4111-8111-111111111111";
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
