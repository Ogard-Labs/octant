import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codeLanguageReferencesFixture as fixture } from "./codeLanguageReferencesTestFixtures";
describe("current document references through real companion and controlled stdio", () => {
  it("maps cross-file references and redacts a hostile symlink without executing a server command", async () => {
    const f = fixture();
    expect(await f.open()).toMatchObject({ status: "synced" });
    const answer = await f.references();
    expect(answer).toMatchObject({
      status: "references",
      documentVersion: 1,
      truncated: false,
      targets: [
        { kind: "checkout-location", path: "a.ts" },
        { kind: "checkout-location", path: "b.ts" },
        { kind: "outside-checkout", label: "elsewhere" },
      ],
    });
    expect(
      f.received.filter((message) => message.method === "textDocument/references"),
    ).toHaveLength(1);
    expect(f.launches).toEqual([f.checkout]);
  });
  it("keeps an extra-folder read inside its authorized root and existing absolute file-open identity", async () => {
    const f = fixture({ extraFolder: true });
    await f.open();
    const result = await f.references();
    expect(result).toMatchObject({
      status: "references",
      targets: [
        { kind: "checkout-location", path: join(f.checkout, "a.ts") },
        { kind: "checkout-location", path: join(f.checkout, "b.ts") },
        { kind: "outside-checkout", label: "elsewhere" },
      ],
    });
    expect(f.launches).toEqual([f.checkout]);
  });
  it.each([false, undefined, null, "yes"])(
    "does not infer reference support from a server with capability=%s",
    async (capability) => {
      const f = fixture({ capability });
      await f.open();
      const expected = capability === false || capability === undefined ? "unsupported" : "unknown";
      expect(await f.capabilities()).toMatchObject({
        status: "capabilities",
        references: expected,
      });
      expect(await f.references()).toEqual({
        status: "unsupported",
        capability: "references",
        support: expected,
      });
      expect(f.received.some((message) => message.method === "textDocument/references")).toBe(
        false,
      );
    },
  );
  it("uses exact matching dynamic registration and removes it when the server unregisters", async () => {
    const f = fixture({ capability: false });
    await f.open();
    f.notify("client/registerCapability", {
      registrations: [
        {
          id: "refs",
          method: "textDocument/references",
          registerOptions: { documentSelector: [{ language: "typescript", scheme: "file" }] },
        },
      ],
    });
    expect(await f.capabilities()).toMatchObject({ references: "supported" });
    expect(await f.references()).toMatchObject({ status: "references" });
    f.notify("client/unregisterCapability", {
      unregisterations: [{ id: "refs", method: "textDocument/references" }],
    });
    expect(await f.capabilities()).toMatchObject({ references: "unsupported" });
    expect(await f.references()).toEqual({
      status: "unsupported",
      capability: "references",
      support: "unsupported",
    });
  });
  it("keeps unsupported selector patterns unknown rather than enabling a project-wide action", async () => {
    const f = fixture({ capability: false });
    await f.open();
    f.notify("client/registerCapability", {
      registrations: [
        {
          id: "refs",
          method: "textDocument/references",
          registerOptions: { documentSelector: [{ language: "typescript", pattern: "**/*.ts" }] },
        },
      ],
    });
    expect(await f.capabilities()).toMatchObject({ references: "unknown" });
    expect(await f.references()).toMatchObject({ status: "unsupported", support: "unknown" });
  });
  it.each(["document", "reach", "checkout", "component", "registration", "deadline"] as const)(
    "refuses results after a held response changes %s",
    async (change) => {
      const f = fixture({ capability: change === "registration" ? false : true });
      await f.open();
      if (change === "registration")
        f.notify("client/registerCapability", {
          registrations: [{ id: "refs", method: "textDocument/references" }],
        });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.state.controls.beforeReferences = () => held;
      const clock = change === "deadline" ? vi.spyOn(performance, "now") : undefined;
      const base = performance.now();
      if (clock) clock.mockReturnValue(base);
      const read = f.references();
      try {
        await vi.waitFor(() =>
          expect(f.received.some((message) => message.method === "textDocument/references")).toBe(
            true,
          ),
        );
        if (change === "document")
          await f.service.syncDocument(f.caller, {
            kind: "change",
            threadId: f.state.thread.id,
            checkoutId: f.state.checkout.id,
            fileId: f.fileId,
            text: "unsaved next version",
          });
        if (change === "reach") f.state.reach = false;
        if (change === "checkout")
          f.state.checkout = { ...f.state.checkout, availability: "unavailable" };
        if (change === "component") f.state.enabled = false;
        if (change === "registration")
          f.notify("client/unregisterCapability", {
            unregisterations: [{ id: "refs", method: "textDocument/references" }],
          });
        if (clock) clock.mockReturnValue(base + 1001);
        release();
        const answer = await read;
        if (change === "document") expect(answer).toEqual({ status: "stale" });
        if (change === "reach") expect(answer).toEqual({ status: "refused", reason: "no-reach" });
        if (change === "checkout")
          expect(answer).toEqual({ status: "refused", reason: "checkout-unavailable" });
        if (change === "component")
          expect(answer).toEqual({ status: "refused", reason: "turned-off" });
        if (change === "registration")
          expect(answer).toMatchObject({ status: "unsupported", support: "unsupported" });
        if (change === "deadline")
          expect(answer).toEqual({ status: "unavailable", reason: "timed-out" });
      } finally {
        release();
        clock?.mockRestore();
        await read;
      }
    },
  );

  it("rechecks the actual current root after mapping before publishing locations", async () => {
    const f = fixture();
    await f.open();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    f.state.controls.beforeRoot = async (count) => {
      if (count === 3) {
        waiting = true;
        await held;
      }
    };
    const read = f.references();
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      const next = join(f.root, "rebound");
      mkdirSync(next);
      writeFileSync(join(next, "b.ts"), "another checkout body");
      f.state.controls.root = next;
      release();
      expect(await read).toEqual({ status: "stale" });
    } finally {
      release();
      await read;
    }
  });

  it.each(["component", "root", "same-path-root"] as const)(
    "never starts or retargets a server when a read sees %s replacement",
    async (change) => {
      const f = fixture();
      await f.open();
      if (change === "component") f.state.controls.componentKey = "replacement-component";
      else if (change === "root") {
        const next = join(f.root, "replacement-checkout");
        mkdirSync(next);
        writeFileSync(join(next, "b.ts"), "replacement body");
        f.state.controls.root = next;
      } else {
        renameSync(f.checkout, join(f.root, "previous-checkout"));
        mkdirSync(f.checkout);
        writeFileSync(join(f.checkout, "b.ts"), "replacement body");
      }
      expect(await f.capabilities()).toEqual({ status: "stale" });
      expect(await f.references()).toEqual({ status: "stale" });
      expect(f.launches).toEqual([f.checkout]);
      expect(f.received.some((message) => message.method === "textDocument/references")).toBe(
        false,
      );
    },
  );

  it.each(["component", "root"] as const)(
    "does not launch from the foreground query sync when a held root check sees %s drift",
    async (change) => {
      const f = fixture();
      const opened = await f.open();
      if (opened.status !== "synced" || opened.documentRevision === undefined)
        throw new Error("No acknowledged document");
      expect(await f.capabilities()).toMatchObject({ references: "supported" });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let waiting = false;
      f.state.controls.beforeRoot = async () => {
        waiting = true;
        await held;
      };
      const guarded = {
        kind: "change" as const,
        threadId: f.state.thread.id,
        checkoutId: f.state.checkout.id,
        fileId: f.fileId,
        text: "query draft",
        expectedRevision: opened.documentRevision,
      };
      const syncing = f.service.syncDocument(f.caller, guarded);
      try {
        await vi.waitFor(() => expect(waiting).toBe(true));
        if (change === "component") f.state.controls.componentKey = "replacement-component";
        else {
          const next = join(f.root, "foreground-rebound");
          mkdirSync(next);
          writeFileSync(join(next, "b.ts"), "another body");
          f.state.controls.root = next;
        }
        release();
        expect(await syncing).toEqual({ status: "stale" });
        expect(f.launches).toEqual([f.checkout]);
        expect(f.received.some((message) => message.method === "textDocument/didChange")).toBe(
          false,
        );
      } finally {
        release();
        await syncing;
      }
    },
  );
  it("refuses foreground preparation with missing original host request proof", async () => {
    const f = fixture();
    const opened = await f.open();
    if (opened.status !== "synced" || opened.documentRevision === undefined)
      throw new Error("No acknowledged document");
    const { isCurrent: _, ...unproven } = f.caller;
    expect(
      await f.service.syncDocument(unproven, {
        kind: "change",
        threadId: f.state.thread.id,
        checkoutId: f.state.checkout.id,
        fileId: f.fileId,
        text: "must not forward",
        expectedRevision: opened.documentRevision,
      }),
    ).toEqual({ status: "refused", reason: "no-reach" });
    expect(f.received.some((message) => message.method === "textDocument/didChange")).toBe(false);
    expect(f.launches).toEqual([f.checkout]);
  });
  it("keeps ordinary change sync launch behavior while exact foreground sync consumes only the ready document", async () => {
    const f = fixture();
    const opened = await f.open();
    if (opened.status !== "synced" || opened.documentRevision === undefined)
      throw new Error("No acknowledged document");
    const input = {
      kind: "change" as const,
      threadId: f.state.thread.id,
      checkoutId: f.state.checkout.id,
      fileId: f.fileId,
      text: "query draft",
      expectedRevision: opened.documentRevision,
    };
    expect(await f.service.syncDocument(f.caller, input)).toMatchObject({
      status: "synced",
      documentVersion: 2,
    });
    expect(f.launches).toEqual([f.checkout]);
    expect(await f.service.syncDocument(f.caller, input)).toEqual({ status: "stale" });
    f.state.controls.componentKey = "replacement-component";
    const { expectedRevision: _, ...ordinary } = input;
    expect(await f.service.syncDocument(f.caller, ordinary)).toMatchObject({ status: "synced" });
    expect(f.launches).toEqual([f.checkout, f.checkout]);
  });

  it("refuses an acknowledged numeric version reused by a replacement open document", async () => {
    const f = fixture();
    const original = await f.open();
    if (original.status !== "synced") throw new Error("Current host did not acknowledge document");
    const oldRevision = original.documentRevision ?? "90000000-0000-4000-8000-000000000001";
    await f.service.syncDocument(f.caller, {
      kind: "close",
      threadId: f.state.thread.id,
      checkoutId: f.state.checkout.id,
      fileId: f.fileId,
    });
    await f.open();
    const request = {
      kind: "references" as const,
      threadId: f.state.thread.id,
      checkoutId: f.state.checkout.id,
      fileId: f.fileId,
      position: { line: 1, character: 13 },
      includeDeclaration: true,
      expectedVersion: 1,
      expectedRevision: oldRevision,
    };
    expect(await f.service.read(f.caller, request)).toEqual({ status: "stale" });
    expect(f.received.some((message) => message.method === "textDocument/references")).toBe(false);
  });

  it("refuses an old acknowledgement after the connection reopens the same numeric document version", async () => {
    const f = fixture();
    const opened = await f.open();
    if (opened.status !== "synced") throw new Error("Current host did not acknowledge document");
    const oldRevision = opened.documentRevision ?? "90000000-0000-4000-8000-000000000001";
    f.disconnect();
    await vi.waitFor(() => expect(f.launches).toHaveLength(2));
    const request = {
      kind: "references" as const,
      threadId: f.state.thread.id,
      checkoutId: f.state.checkout.id,
      fileId: f.fileId,
      position: { line: 1, character: 13 },
      includeDeclaration: true,
      expectedVersion: 1,
      expectedRevision: oldRevision,
    };
    expect(await f.service.read(f.caller, request)).toEqual({ status: "stale" });
    expect(f.received.some((message) => message.method === "textDocument/references")).toBe(false);
  });
});
