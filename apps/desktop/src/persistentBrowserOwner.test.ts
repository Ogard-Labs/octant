import { describe, expect, it, vi } from "vitest";
import {
  decodeBrowserContextId,
  decodeBrowserContextPolicy,
  decodePersistentBrowserLeaseBinding,
} from "@octant/contracts";
import { createPersistentBrowserOwner } from "./persistentBrowserOwner";

const contextId = decodeBrowserContextId("10000000-0000-4000-8000-000000000003");
const policy = decodeBrowserContextPolicy({
  profileMode: "isolated",
  profile: { kind: "personal" },
  allowedOrigins: ["https://example.com"],
  credentialFieldProtection: true,
  maxConcurrentTabs: 1,
  sessionTimeoutMs: 60000,
});
const start = Date.parse("2026-11-07T20:00:00.000Z");
function fixture() {
  const pages = new Set<string>();
  let time = start;
  const open = vi.fn<Parameters<typeof createPersistentBrowserOwner>[0]["open"]>(async (id) => {
    pages.add(id);
  });
  const close = vi.fn(async (id: string) => {
    pages.delete(id);
  });
  const owner = createPersistentBrowserOwner({
    exists: (id) => pages.has(String(id)),
    open,
    close,
    now: () => time,
  });
  const binding = (ownerId: string) =>
    decodePersistentBrowserLeaseBinding({
      ownerId,
      grantId: "10000000-0000-4000-8000-000000000002",
      executionId: "one-run",
      threadId: contextId,
      mode: "code",
      projectId: "10000000-0000-4000-8000-000000000004",
      providerId: "provider",
      modelId: "model",
      authorityRevision: "authority",
      profile: { kind: "personal" },
      origins: ["https://example.com"],
      expiresAt: new Date(start + 60000).toISOString(),
    });
  return {
    owner,
    binding,
    open,
    close,
    pages,
    expire: () => {
      time += 60001;
    },
  };
}

describe("one persistent native Browser owner", () => {
  it("starts disabled, mints execution-only receipts and never reuses a retired owner", async () => {
    const f = fixture();
    expect(f.owner.status()).toEqual({ status: "disabled" });
    expect(
      await f.owner.createContext(
        contextId,
        policy,
        new AbortController().signal,
        f.binding(contextId),
      ),
    ).toEqual({ status: "unavailable" });
    const ready = await f.owner.configure(true);
    if (ready.status !== "ready") throw Error("owner missing");
    const created = await f.owner.createContext(
      contextId,
      policy,
      new AbortController().signal,
      f.binding(ready.ownerId),
    );
    expect(created.status).toBe("created");
    expect(f.open.mock.calls[0]?.[2]).toMatchObject({
      kind: "execution",
      ownerId: ready.ownerId,
      threadId: contextId,
    });
    expect(f.open.mock.calls[0]?.[2]).not.toHaveProperty("windowId");
    await f.owner.configure(false);
    expect(f.pages.size).toBe(0);
    const replacement = await f.owner.configure(true);
    if (replacement.status !== "ready") throw Error("owner missing");
    expect(replacement.ownerId).not.toBe(ready.ownerId);
    expect(
      await f.owner.createContext(
        contextId,
        policy,
        new AbortController().signal,
        f.binding(ready.ownerId),
      ),
    ).toEqual({ status: "unavailable" });
    await f.owner.close();
    expect(f.owner.status().status).toBe("unavailable");
  });
  it("refuses a broader native policy and expires only its execution context", async () => {
    const f = fixture();
    const ready = await f.owner.configure(true);
    if (ready.status !== "ready") throw Error("owner missing");
    const broader = {
      ...policy,
      allowedOrigins: [...policy.allowedOrigins, "https://other.example"],
    };
    expect(
      await f.owner.createContext(
        contextId,
        broader,
        new AbortController().signal,
        f.binding(ready.ownerId),
      ),
    ).toEqual({ status: "unavailable" });
    expect(f.open).not.toHaveBeenCalled();
    const created = await f.owner.createContext(
      contextId,
      policy,
      new AbortController().signal,
      f.binding(ready.ownerId),
    );
    if (created.status !== "created") throw Error("context missing");
    expect(
      f.owner.admits({
        kind: "execution",
        ownerId: created.ownerId,
        leaseId: created.leaseId,
        threadId: contextId,
      }),
    ).toBe(true);
    f.expire();
    await f.owner.sweep();
    expect(f.pages.size).toBe(0);
    expect(
      f.owner.admits({
        kind: "execution",
        ownerId: created.ownerId,
        leaseId: created.leaseId,
        threadId: contextId,
      }),
    ).toBe(false);
    await f.owner.close();
  });
  it("keeps a cancelled late native opening reserved until its own view has closed", async () => {
    const f = fixture();
    const ready = await f.owner.configure(true);
    if (ready.status !== "ready") throw Error("owner missing");
    const opening = Promise.withResolvers<void>();
    f.open.mockImplementation(async (id) => {
      await opening.promise;
      f.pages.add(String(id));
    });
    const controller = new AbortController();
    const pending = f.owner.createContext(
      contextId,
      policy,
      controller.signal,
      f.binding(ready.ownerId),
    );
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    controller.abort();
    expect(
      await f.owner.createContext(
        contextId,
        policy,
        new AbortController().signal,
        f.binding(ready.ownerId),
      ),
    ).toEqual({ status: "unavailable" });
    opening.resolve();
    expect(await pending).toEqual({ status: "unavailable" });
    await f.owner.sweep();
    expect(f.pages.size).toBe(0);
    await f.owner.close();
  });
  it("invalidates all execution receipts on host restart and closes admission after explicit quit", async () => {
    const f = fixture();
    const ready = await f.owner.configure(true);
    if (ready.status !== "ready") throw Error("owner missing");
    await f.owner.createContext(
      contextId,
      policy,
      new AbortController().signal,
      f.binding(ready.ownerId),
    );
    await f.owner.restart();
    expect(f.pages.size).toBe(0);
    expect(f.owner.status()).not.toEqual(ready);
    expect(
      await f.owner.createContext(
        contextId,
        policy,
        new AbortController().signal,
        f.binding(ready.ownerId),
      ),
    ).toEqual({ status: "unavailable" });
    await f.owner.close();
    expect(await f.owner.configure(true)).toEqual({ status: "unavailable" });
  });
});
