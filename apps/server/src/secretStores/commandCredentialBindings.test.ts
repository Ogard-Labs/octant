import { decodeWindowId } from "@octant/contracts";
import { describe, it, expect, vi } from "vitest";
import {
  decodeCommandCredentialBinding,
  decodeCommandCredentialDefinition,
} from "@octant/contracts/command-credentials";
import type { CommandCredentialBindingsOptions } from "./commandCredentialBindings";
import { CommandCredentialBindings } from "./commandCredentialBindings";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition = decodeCommandCredentialDefinition({
  label: "Read account",
  projectId: id(1),
  executable: "/usr/local/bin/fixture-client",
  args: ["account", "status"],
  directory: "",
  accountId: "a".repeat(26),
  environment: [
    { name: "API_TOKEN", vaultId: "v".repeat(26), itemId: "i".repeat(26), fieldId: "credential" },
  ],
  timeoutMs: 1000,
});
function fixture(extra: Partial<CommandCredentialBindingsOptions> = {}) {
  let current = true;
  let now = 1000;
  const records: unknown[] = [];
  const execute = vi.fn<CommandCredentialBindingsOptions["execute"]>(
    async (_binding, _context, _signal, before, onStart) => {
      if (before()) onStart();
      return {
        status: before() ? ("exited" as const) : ("cancelled" as const),
        effect: before() ? ("completed" as const) : ("none" as const),
        exitCode: 0,
        output: "<concealed>",
        truncated: false,
      };
    },
  );
  const service = new CommandCredentialBindings({
    now: () => now,
    uuid: (() => {
      let n = 10;
      return () => id(n++);
    })(),
    canConfigure: () => current,
    context: async (windowId, threadId) =>
      current
        ? {
            windowId,
            threadId,
            projectId: definition.projectId,
            root: "/fixture",
            authorityKey: "one",
            executionPolicy: "full-access",
            current: () => current,
            revalidate: async () => current,
          }
        : undefined,
    pin: async (executable) => ({
      executable,
      digest: "a".repeat(64),
      credentialExecutable: "/opt/homebrew/bin/op",
      credentialExecutableDigest: "b".repeat(64),
      credentialVersion: "2.33.0",
    }),
    execute,
    record: (record) => {
      records.push(record);
    },
    records: [],
    ...extra,
  });
  return {
    service,
    execute,
    records,
    change: () => {
      current = false;
    },
    expire: () => {
      now += 180001;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("explicit named credential commands", () => {
  it.each(["approval-gated", "auto-accept-edits"])(
    "prepares a separately approved fixed credential command at %s without widening its posture",
    async (executionPolicy) => {
      const f = fixture({
        context: async (windowId, threadId) => ({
          windowId,
          threadId,
          projectId: String(definition.projectId),
          root: "/fixture",
          authorityKey: executionPolicy,
          executionPolicy,
          current: () => true,
          revalidate: async () => true,
        }),
      });
      try {
        const saved = await f.service.save(id(2), definition);
        if (saved.kind !== "command-credential-view" || !saved.bindings[0])
          throw Error("Expected saved binding");
        expect(
          await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4)),
        ).toMatchObject({ kind: "command-credential-view", requests: [{ state: "pending" }] });
        expect(f.execute).not.toHaveBeenCalled();
      } finally {
        f.service.close();
      }
    },
  );

  it("runs the reviewed fixed binding only after one approval and replays its receipt without another process", async () => {
    const f = fixture();
    const saved = await f.service.save(id(2), definition);
    if (saved.kind !== "command-credential-view" || !saved.bindings[0])
      throw Error("Expected binding");
    const reviewed = await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4));
    if (reviewed.kind !== "command-credential-view" || !reviewed.requests[0])
      throw Error("Expected review");
    expect(f.execute).not.toHaveBeenCalled();
    const requestId = reviewed.requests[0].requestId;
    expect(await f.service.approve(id(2), requestId)).toMatchObject({
      status: "exited",
      effect: "completed",
    });
    expect(await f.service.approve(id(2), requestId)).toMatchObject({
      status: "exited",
      effect: "completed",
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.records.some((value) => JSON.stringify(value).includes("<concealed>"))).toBe(false);
  });
  it.each(["authority", "expiry"])(
    "starts no process when %s changes after review",
    async (change) => {
      const f = fixture();
      const saved = await f.service.save(id(2), definition);
      if (saved.kind !== "command-credential-view" || !saved.bindings[0])
        throw Error("Expected binding");
      const reviewed = await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4));
      if (reviewed.kind !== "command-credential-view" || !reviewed.requests[0])
        throw Error("Expected review");
      if (change === "authority") f.change();
      else f.expire();
      expect(await f.service.approve(id(2), reviewed.requests[0].requestId)).toMatchObject(
        change === "authority"
          ? { kind: "command-credential-refused", reason: "unauthorized" }
          : { effect: "none" },
      );
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it("does not publish a settled receipt after its Project authority is lost", async () => {
    const f = fixture();
    const saved = await f.service.save(id(2), definition);
    if (saved.kind !== "command-credential-view" || !saved.bindings[0])
      throw Error("Expected binding");
    const reviewed = await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4));
    if (reviewed.kind !== "command-credential-view" || !reviewed.requests[0])
      throw Error("Expected review");
    const request = reviewed.requests[0].requestId;
    await f.service.approve(id(2), request);
    f.change();
    expect(await f.service.approve(id(2), request)).toMatchObject({
      kind: "command-credential-refused",
      reason: "unauthorized",
    });
    expect(await f.service.wait(id(2), request)).toMatchObject({
      kind: "command-credential-refused",
      reason: "unauthorized",
    });
    expect(await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4))).toMatchObject({
      kind: "command-credential-refused",
      reason: "unauthorized",
    });
  });
  it("requires a fresh approval after a preparation receipt is pruned and refuses the old approval", async () => {
    const f = fixture();
    const saved = await f.service.save(id(2), definition);
    if (saved.kind !== "command-credential-view" || !saved.bindings[0])
      throw Error("Expected binding");
    const reviewed = await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4));
    if (reviewed.kind !== "command-credential-view" || !reviewed.requests[0])
      throw Error("Expected review");
    await f.service.approve(id(2), reviewed.requests[0].requestId);
    f.advance(300000);
    f.service.view(id(2));
    const fresh = await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4));
    if (fresh.kind !== "command-credential-view" || !fresh.requests[0])
      throw Error("Expected new review");
    expect(fresh.requests[0].requestId).not.toBe(reviewed.requests[0].requestId);
    expect(await f.service.approve(id(2), reviewed.requests[0].requestId)).toMatchObject({
      kind: "command-credential-refused",
      reason: "unauthorized",
    });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("lets an already started command outlive the approval deadline within its execution timeout", async () => {
    const f = fixture();
    let finish:
      | ((value: {
          status: "exited";
          effect: "completed";
          exitCode: number;
          output: string;
          truncated: boolean;
        }) => void)
      | undefined;
    f.execute.mockImplementationOnce(async (_binding, _context, signal, before, onStart) => {
      if (!before()) throw Error("Expected admission");
      onStart();
      return await new Promise((resolve) => {
        finish = resolve;
        signal.addEventListener(
          "abort",
          () => resolve({ status: "cancelled", effect: "possible", output: "", truncated: false }),
          { once: true },
        );
      });
    });
    const saved = await f.service.save(id(2), definition);
    if (saved.kind !== "command-credential-view" || !saved.bindings[0])
      throw Error("Expected binding");
    const reviewed = await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4));
    if (reviewed.kind !== "command-credential-view" || !reviewed.requests[0])
      throw Error("Expected review");
    const running = f.service.approve(id(2), reviewed.requests[0].requestId);
    await Promise.resolve();
    await Promise.resolve();
    f.advance(280001);
    f.service.view(id(2));
    if (finish === undefined) throw Error("Expected running command");
    finish({ status: "exited", effect: "completed", exitCode: 0, output: "", truncated: false });
    expect(await running).toMatchObject({ status: "exited", effect: "completed" });
    const retained = f.service.view(id(2));
    expect(retained.kind === "command-credential-view" ? retained.receipts : []).toHaveLength(1);
    f.advance(60001);
    const evicted = f.service.view(id(2));
    expect(evicted.kind === "command-credential-view" ? evicted.receipts : []).toHaveLength(0);
  });
  it("rechecks binding capacity after concurrent executable verification", async () => {
    let release:
      | ((value: {
          readonly executable: string;
          readonly digest: string;
          readonly credentialExecutable: string;
          readonly credentialExecutableDigest: string;
          readonly credentialVersion: string;
        }) => void)
      | undefined;
    const pin = new Promise<{
      readonly executable: string;
      readonly digest: string;
      readonly credentialExecutable: string;
      readonly credentialExecutableDigest: string;
      readonly credentialVersion: string;
    }>((resolve) => {
      release = resolve;
    });
    const records = Array.from({ length: 63 }, (_, index) => ({
      name: "command-binding.saved" as const,
      windowId: decodeWindowId(id(2)),
      binding: decodeCommandCredentialBinding({
        kind: "command-credential-binding",
        bindingId: id(1000 + index),
        revision: 1,
        definition,
        executableDigest: "a".repeat(64),
        credentialExecutable: "/usr/local/bin/op",
        credentialExecutableDigest: "b".repeat(64),
        credentialVersion: "2.33.0",
      }),
    }));
    const f = fixture({ records, pin: async () => pin });
    const first = f.service.save(id(2), definition);
    const second = f.service.save(id(2), definition);
    if (release === undefined) throw Error("Expected verification");
    release({
      executable: definition.executable,
      digest: "a".repeat(64),
      credentialExecutable: "/usr/local/bin/op",
      credentialExecutableDigest: "b".repeat(64),
      credentialVersion: "2.33.0",
    });
    const results = await Promise.all([first, second]);
    expect(
      results.filter(
        (result) => result.kind === "command-credential-refused" && result.reason === "limit",
      ),
    ).toHaveLength(1);
    expect(f.service.view(id(2))).toMatchObject({ bindings: expect.any(Array) });
    const view = f.service.view(id(2));
    expect(view.kind === "command-credential-view" ? view.bindings.length : 0).toBe(64);
    f.service.close();
  });
  it("never revives an old approval when the same window identity is registered again", async () => {
    const f = fixture();
    const saved = await f.service.save(id(2), definition);
    if (saved.kind !== "command-credential-view" || !saved.bindings[0])
      throw Error("Expected binding");
    const review = await f.service.review(id(2), id(3), saved.bindings[0].bindingId, id(4));
    if (review.kind !== "command-credential-view" || !review.requests[0])
      throw Error("Expected review");
    f.service.windowRevoked(id(2));
    expect(await f.service.approve(id(2), review.requests[0].requestId)).toMatchObject({
      kind: "command-credential-refused",
      reason: "unauthorized",
    });
    expect(f.execute).not.toHaveBeenCalled();
    f.service.close();
  });
});
