import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createNativeBrowserPresentationRoutes } from "./nativeBrowserPresentationRoutes";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const command = {
  kind: "attach",
  contextId: "00000000-0000-4000-8000-000000000902",
  threadId: "00000000-0000-4000-8000-000000000903",
};
function fixture(native = true) {
  let now = 1_000;
  const capability = randomBytes(32).toString("base64url");
  const store = new WindowAuthorityStore(undefined, {
    elapsedNow: () => now,
    schedule: () => () => {},
  });
  const rendererIdentity = randomBytes(32).toString("base64url");
  const base = { windowId, capability, now };
  if (native)
    store.registerNative({
      ...base,
      rendererIdentity,
      source: {
        kind: "native-nightly",
        processRegistration: randomBytes(32).toString("base64url"),
        incarnation: "a".repeat(64),
        generation: 7,
      },
    });
  else store.registerOrRefresh({ ...base, rendererIdentity });
  const humanPresentation = vi.fn(async () => ({ status: "idle" as const }));
  const owns = vi.fn(() => true);
  const handle = createNativeBrowserPresentationRoutes({
    store,
    runtime: { humanPresentation },
    owns,
    now: () => now,
  });
  const request = (body = JSON.stringify(command)) =>
    new Request("http://127.0.0.1/api/browser/human-presentation", {
      method: "POST",
      headers: {
        "x-octant-window-capability": capability,
        "x-octant-human-presentation": rendererIdentity,
      },
      body,
    });
  return {
    handle,
    request,
    store,
    humanPresentation,
    owns,
    expire: () => {
      now = 16_000;
    },
  };
}

describe("human Browser presentation authority", () => {
  it("keeps every page editing operation behind the current main-only native authority", async () => {
    const f = fixture();
    const owner = {
      contextId: command.contextId,
      threadId: command.threadId,
      presentationId: "00000000-0000-4000-8000-000000000904",
    };
    const menuId = "00000000-0000-4000-8000-000000000905";
    for (const operation of [
      { kind: "edit-menu" },
      { kind: "edit-menu-watch", menuId },
      { kind: "edit-menu-keyboard", menuId },
      { kind: "edit-menu-dismiss", menuId },
      { kind: "edit-menu-action", menuId, action: "copy" },
    ]) {
      const raw = JSON.stringify({ ...owner, ...operation });
      const ordinary = f.request(raw);
      ordinary.headers.set(
        "x-octant-renderer-identity",
        ordinary.headers.get("x-octant-human-presentation") ?? "",
      );
      ordinary.headers.delete("x-octant-human-presentation");
      const before = f.humanPresentation.mock.calls.length;
      expect((await f.handle(ordinary))?.status).toBe(403);
      expect(f.humanPresentation).toHaveBeenCalledTimes(before);
      expect((await f.handle(f.request(raw)))?.status).toBe(200);
    }
    f.expire();
    expect(
      (
        await f.handle(
          f.request(JSON.stringify({ ...owner, kind: "edit-menu-action", menuId, action: "copy" })),
        )
      )?.status,
    ).toBe(403);
    expect(f.humanPresentation).toHaveBeenCalledTimes(5);
  });

  it("dispatches only a current native window's existing owned context", async () => {
    const f = fixture();
    expect((await f.handle(f.request()))?.status).toBe(200);
    expect(f.humanPresentation).toHaveBeenCalledWith(command, windowId, expect.any(AbortSignal));
    f.owns.mockReturnValue(false);
    expect((await f.handle(f.request()))?.status).toBe(403);
    expect(f.humanPresentation).toHaveBeenCalledTimes(1);
    const legacy = fixture(false);
    expect((await legacy.handle(legacy.request()))?.status).toBe(403);
    expect(legacy.humanPresentation).not.toHaveBeenCalled();
  });

  it("requires the main-only header rather than the renderer's ordinary capability or identity header", async () => {
    const f = fixture();
    const absent = f.request();
    absent.headers.delete("x-octant-human-presentation");
    expect((await f.handle(absent))?.status).toBe(403);
    const ordinary = f.request();
    ordinary.headers.set(
      "x-octant-renderer-identity",
      ordinary.headers.get("x-octant-human-presentation") ?? "",
    );
    ordinary.headers.delete("x-octant-human-presentation");
    expect((await f.handle(ordinary))?.status).toBe(403);
    const wrong = f.request();
    wrong.headers.set("x-octant-human-presentation", "A".repeat(43));
    expect((await f.handle(wrong))?.status).toBe(403);
    expect(f.humanPresentation).not.toHaveBeenCalled();
    expect(f.owns).not.toHaveBeenCalled();
  });

  it("rejects injected identity and UTF8 overflow before any runtime operation", async () => {
    const f = fixture();
    expect((await f.handle(f.request(JSON.stringify({ ...command, windowId }))))?.status).toBe(403);
    const oversized = JSON.stringify({ ...command, extra: "é".repeat(9_000) });
    expect(oversized.length).toBeLessThan(16_384);
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(16_384);
    expect((await f.handle(f.request(oversized)))?.status).toBe(403);
    expect(f.humanPresentation).not.toHaveBeenCalled();
  });

  it("suppresses results after the original lease expires or its context is replaced", async () => {
    const f = fixture();
    f.humanPresentation.mockImplementation(async () => {
      f.expire();
      return { status: "idle" };
    });
    expect((await f.handle(f.request()))?.status).toBe(403);
    const replaced = fixture();
    replaced.humanPresentation.mockImplementation(async () => {
      replaced.owns.mockReturnValue(false);
      return { status: "idle" };
    });
    expect((await replaced.handle(replaced.request()))?.status).toBe(403);
  });
});
