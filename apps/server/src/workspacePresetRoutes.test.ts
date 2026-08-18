import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { decodeWorkspacePreset } from "@octant/contracts/workspace-presets";
import { createWorkspacePresetRouteHandler } from "./workspacePresetRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const threadId = "20000000-0000-4000-8000-000000000001";
const checkoutId = "30000000-0000-4000-8000-000000000001";
const groupId = "40000000-0000-4000-8000-000000000001";

const preset = decodeWorkspacePreset({
  id: "design-studio",
  displayName: "Design studio",
  summary: "The project, a live preview, and a side conversation.",
  mode: "code",
  panes: ["code-overview", "browser", "side-chat"],
  defaultSkills: ["frontend-design"],
});

function fixture(overrides: Partial<Parameters<typeof createWorkspacePresetRouteHandler>[0]> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const applyOperations = vi.fn(async () => 7 as never);
  const handler = createWorkspacePresetRouteHandler(
    {
      presets: [preset],
      windowAuthorityStore: store,
      resolveTarget: async () => ({
        groupId: groupId as never,
        mentionableThreadId: threadId as never,
        title: "Release",
      }),
      applyOperations,
      resolveSkills: async () => [{ name: "frontend-design", enabled: false }],
      ...overrides,
      now: () => 1,
      clock: () => "2026-08-18T09:00:00.000Z",
    },
    () => crypto.randomUUID() as never,
  );
  return { applyOperations, handler };
}

function apply(capability: string, body: unknown): Request {
  return new Request("http://127.0.0.1:4000/api/workspace-presets/apply", {
    method: "POST",
    headers: { "content-type": "application/json", "x-octant-window-capability": capability },
    body: JSON.stringify(body),
  });
}

describe("workspace preset routes", () => {
  it("lists the presets the host pinned", async () => {
    const { handler } = fixture();

    const response = await handler(
      new Request("http://127.0.0.1:4000/api/workspace-presets", {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { presets: ReadonlyArray<{ id: string }> };
    expect(body.presets.map((entry) => entry.id)).toEqual(["design-studio"]);
  });

  it("refuses a caller without this window's capability", async () => {
    const { applyOperations, handler } = fixture();

    const response = await handler(
      apply("not-a-capability", { presetId: "design-studio", threadId, checkoutId }),
    );

    expect(response?.status).toBe(401);
    expect(applyOperations).not.toHaveBeenCalled();
  });

  it("composes the operations from the pinned preset rather than from the request", async () => {
    const { applyOperations, handler } = fixture();

    const response = await handler(
      apply(capability, {
        presetId: "design-studio",
        threadId,
        checkoutId,
        // A layout the caller tried to smuggle in. The body has no such field,
        // so the request is refused outright rather than partly honoured.
        operations: [{ kind: "close-tab" }],
      }),
    );

    expect(response?.status).toBe(400);
    expect(applyOperations).not.toHaveBeenCalled();
  });

  it("opens the preset's panes and reports where its skills stand", async () => {
    const { applyOperations, handler } = fixture();

    const response = await handler(
      apply(capability, { presetId: "design-studio", threadId, checkoutId }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      kind: "workspace-preset-applied",
      presetId: "design-studio",
      version: 7,
      opened: ["code-overview", "browser", "side-chat"],
      // Reported, not enabled: the preset changed nothing about activation.
      skills: [{ name: "frontend-design", status: "installed-not-enabled" }],
    });
    expect(applyOperations).toHaveBeenCalledOnce();
  });

  it("refuses a preset aimed at a thread this window does not have open", async () => {
    const { applyOperations, handler } = fixture({ resolveTarget: async () => undefined });

    const response = await handler(
      apply(capability, { presetId: "design-studio", threadId, checkoutId }),
    );

    expect(response?.status).toBe(409);
    expect(applyOperations).not.toHaveBeenCalled();
  });

  it("refuses a preset the host never pinned", async () => {
    const { applyOperations, handler } = fixture();

    const response = await handler(
      apply(capability, { presetId: "not-a-preset", threadId, checkoutId }),
    );

    expect(response?.status).toBe(404);
    expect(applyOperations).not.toHaveBeenCalled();
  });
});
