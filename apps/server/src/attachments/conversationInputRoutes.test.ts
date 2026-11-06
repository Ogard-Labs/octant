import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { classifyProductAction } from "../authenticatedProductRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createConversationInputRoutes } from "./conversationInputRoutes";

const id = "11111111-1111-4111-8111-111111111111";
const query = `mode=work&threadId=${id}&admissionId=${id}&snapshotId=${id}`;
function fixture() {
  const capability = randomBytes(32).toString("base64url");
  const store = new WindowAuthorityStore();
  store.register({ windowId: decodeWindowId(id), capability, now: 0 });
  const read = vi.fn(async () => undefined);
  const handle = createConversationInputRoutes({ windowAuthorityStore: store, now: () => 0, read });
  const request = (extra = "", authorized = true) =>
    new Request(`http://127.0.0.1/api/conversation-inputs?${query}${extra}`, {
      headers: authorized ? { "x-octant-window-capability": capability } : {},
    });
  return { read, handle, request };
}
describe("reading admitted original inputs", () => {
  it("authenticates before resolving a manifest and accepts only host-resolvable identities", async () => {
    const f = fixture();
    expect((await f.handle(f.request("", false)))?.status).toBe(401);
    expect(f.read).not.toHaveBeenCalled();
    await f.handle(f.request("&path=/private/secret"));
    expect(f.read).not.toHaveBeenCalled();
    const response = await f.handle(f.request());
    expect(await response?.json()).toEqual({ status: "unavailable" });
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(f.read).toHaveBeenCalledWith(id, {
      mode: "work",
      threadId: id,
      admissionId: id,
      snapshotId: id,
    });
  });
  it("never classifies a write or reads for a foreign origin", async () => {
    const f = fixture();
    const foreign = new Request(f.request(), { headers: { origin: "https://foreign.invalid" } });
    expect((await f.handle(foreign))?.status).toBe(400);
    expect(f.read).not.toHaveBeenCalled();
    expect(classifyProductAction(f.request())).toBe("project.overview.read");
    expect(classifyProductAction(new Request(f.request(), { method: "POST" }))).toBeUndefined();
  });
});
