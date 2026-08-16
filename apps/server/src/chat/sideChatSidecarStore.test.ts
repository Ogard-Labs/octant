import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeChatThreadId,
  decodeMentionableThreadId,
  type SideChatSidecar,
} from "@octant/contracts";
import { SideChatSidecarStore } from "./sideChatSidecarStore";

/**
 * Hook that lets one write be held open while another completes, so a race
 * between two admissions is deterministic instead of timing-dependent.
 */
const writeGate = vi.hoisted(() => ({
  hold: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const hold = writeGate.hold;
      writeGate.hold = undefined;
      if (hold !== undefined) await hold();
      return actual.writeFile(...args);
    },
  };
});

let root: string;
let store: SideChatSidecarStore;

function sidecar(overrides: Partial<SideChatSidecar> = {}): SideChatSidecar {
  return {
    sourceThreadId: decodeMentionableThreadId("00000000-0000-4000-8000-000000000101"),
    sourceMode: "work",
    sidecarThreadId: decodeChatThreadId("00000000-0000-4000-8000-000000000201"),
    title: "Side Chat about Release notes",
    createdAt: "2026-08-14T10:00:00.000Z" as SideChatSidecar["createdAt"],
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-side-chat-"));
  store = new SideChatSidecarStore(root);
  await store.hydrate();
});

afterEach(async () => {
  writeGate.hold = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("SideChatSidecarStore", () => {
  it("starts empty and reports no hidden threads", () => {
    expect(store.list()).toEqual([]);
    expect(store.hiddenThreadIds().size).toBe(0);
  });

  it("records one sidecar per source thread and hides its Chat thread", async () => {
    const recorded = await store.record(sidecar());
    await store.confirmInheritance(sidecar().sourceThreadId);

    expect(recorded).toEqual(sidecar());
    expect(store.find(sidecar().sourceThreadId)).toEqual(sidecar());
    expect([...store.hiddenThreadIds()]).toEqual(["00000000-0000-4000-8000-000000000201"]);
  });

  it("keeps a claim unusable until its sidecar thread is confirmed", async () => {
    // The claim is written before Chat is asked for the thread, so between the
    // two the link names a thread that may not exist and may not carry the
    // source thread's provider/model. Serving it would hand the source
    // transcript to whatever selection that thread happens to hold.
    await store.record(sidecar());

    expect(store.inheritancePending(sidecar().sourceThreadId)).toBe(true);
    expect(store.find(sidecar().sourceThreadId)).toBeUndefined();
    expect(store.findBySidecarThread(sidecar().sidecarThreadId)).toBeUndefined();
    // It is still hidden: the claimed thread must never surface in Recents.
    expect([...store.hiddenThreadIds()]).toEqual(["00000000-0000-4000-8000-000000000201"]);

    await store.confirmInheritance(sidecar().sourceThreadId);

    expect(store.inheritancePending(sidecar().sourceThreadId)).toBe(false);
    expect(store.find(sidecar().sourceThreadId)).toEqual(sidecar());
    expect(store.findBySidecarThread(sidecar().sidecarThreadId)).toEqual(sidecar());
  });

  it("carries an unconfirmed claim across a restart", async () => {
    await store.record(sidecar());

    const reopened = new SideChatSidecarStore(root);
    await reopened.hydrate();

    expect(reopened.inheritancePending(sidecar().sourceThreadId)).toBe(true);
    expect(reopened.find(sidecar().sourceThreadId)).toBeUndefined();
    expect(reopened.hiddenThreadIds().size).toBe(1);
  });

  it("keeps the first sidecar when a second open races the same source thread", async () => {
    await store.record(sidecar());

    const second = await store.record(
      sidecar({ sidecarThreadId: decodeChatThreadId("00000000-0000-4000-8000-000000000202") }),
    );

    expect(String(second.sidecarThreadId)).toBe("00000000-0000-4000-8000-000000000201");
    expect(store.hiddenThreadIds().size).toBe(1);
  });

  it("keeps every link when two source threads are admitted concurrently", async () => {
    const other = sidecar({
      sourceThreadId: decodeMentionableThreadId("00000000-0000-4000-8000-000000000102"),
      sidecarThreadId: decodeChatThreadId("00000000-0000-4000-8000-000000000202"),
      createdAt: "2026-08-14T10:00:01.000Z" as SideChatSidecar["createdAt"],
    });

    // The first admission's write is held open long enough for a second
    // admission to run to completion, so the two writes resolve out of order —
    // the shape of a real race between two source threads admitted at once.
    let reachedWrite = (): void => {};
    const writing = new Promise<void>((resolve) => {
      reachedWrite = resolve;
    });
    writeGate.hold = async () => {
      reachedWrite();
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const first = store.record(sidecar());
    await writing;
    const second = store.record(other);

    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();

    const persisted = JSON.parse(await readFile(join(root, "side-chat", "sidecars.json"), "utf8"));
    expect(persisted).toHaveLength(2);

    const reopened = new SideChatSidecarStore(root);
    await reopened.hydrate();
    expect([...reopened.hiddenThreadIds()].sort()).toEqual([
      "00000000-0000-4000-8000-000000000201",
      "00000000-0000-4000-8000-000000000202",
    ]);
  });

  it("keeps no link a failed write never persisted, and retries on the next admission", async () => {
    writeGate.hold = async () => {
      throw new Error("no space left on device");
    };

    await expect(store.record(sidecar())).rejects.toThrow(/no space left on device/);

    // The registry on disk never gained the link, so memory must not report it
    // as authoritative either: a retry would otherwise return the in-memory
    // entry without ever attempting another write, and the sidecar thread
    // would reappear as an ordinary Recent on the next boot.
    expect(store.find(sidecar().sourceThreadId)).toBeUndefined();
    expect(store.hiddenThreadIds().size).toBe(0);
    expect(store.list()).toEqual([]);

    const retried = await store.record(sidecar());
    await store.confirmInheritance(sidecar().sourceThreadId);

    expect(retried).toEqual(sidecar());
    const persisted = JSON.parse(await readFile(join(root, "side-chat", "sidecars.json"), "utf8"));
    expect(persisted).toEqual([sidecar()]);
  });

  it("never lets a queued admission republish a link whose own write failed", async () => {
    const other = sidecar({
      sourceThreadId: decodeMentionableThreadId("00000000-0000-4000-8000-000000000102"),
      sidecarThreadId: decodeChatThreadId("00000000-0000-4000-8000-000000000202"),
      createdAt: "2026-08-14T10:00:01.000Z" as SideChatSidecar["createdAt"],
    });

    // The failing write is held open long enough for a second admission for a
    // different source thread to queue behind it, so the second write's
    // snapshot is taken after the first was rolled back.
    let reachedWrite = (): void => {};
    const writing = new Promise<void>((resolve) => {
      reachedWrite = resolve;
    });
    writeGate.hold = async () => {
      reachedWrite();
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("no space left on device");
    };

    const first = store.record(sidecar());
    await writing;
    const second = store.record(other);

    await expect(first).rejects.toThrow(/no space left on device/);
    await expect(second).resolves.toEqual(other);
    await store.confirmInheritance(other.sourceThreadId);

    expect(store.find(sidecar().sourceThreadId)).toBeUndefined();
    expect(store.find(other.sourceThreadId)).toEqual(other);
    const persisted = JSON.parse(await readFile(join(root, "side-chat", "sidecars.json"), "utf8"));
    expect(persisted).toEqual([other]);
  });

  it("survives a restart", async () => {
    await store.record(sidecar());
    await store.confirmInheritance(sidecar().sourceThreadId);

    const reopened = new SideChatSidecarStore(root);
    await reopened.hydrate();

    expect(reopened.find(sidecar().sourceThreadId)).toEqual(sidecar());
  });

  it("forgets a link by source thread and by sidecar thread", async () => {
    await store.record(sidecar());
    await store.forget(sidecar().sourceThreadId);
    expect(store.find(sidecar().sourceThreadId)).toBeUndefined();

    await store.record(sidecar());
    await store.forgetSidecarThread(sidecar().sidecarThreadId);
    expect(store.list()).toEqual([]);
  });

  it("starts empty when the host has no registry file yet", async () => {
    // Absent is not corrupt: a host that has never opened a Side Chat has no
    // links to lose, so it must start empty and stay writable.
    const fresh = new SideChatSidecarStore(join(root, "unused"));
    await fresh.hydrate();

    expect(fresh.list()).toEqual([]);
    await expect(fresh.record(sidecar())).resolves.toBeDefined();
  });

  it("refuses every write rather than overwriting a registry it could not read", async () => {
    // The links are recorded nowhere else, so an unreadable file is the only
    // record that these sidecars exist. Starting empty would let the next open
    // mint a second sidecar and flush the corrupt file away with it.
    await mkdir(join(root, "side-chat"), { recursive: true });
    await writeFile(join(root, "side-chat", "sidecars.json"), "{not json", "utf8");

    const reopened = new SideChatSidecarStore(root);
    await reopened.hydrate();

    await expect(reopened.record(sidecar())).rejects.toThrow(/registry/i);
    await expect(reopened.forget(sidecar().sourceThreadId)).rejects.toThrow(/registry/i);
    expect(await readFile(join(root, "side-chat", "sidecars.json"), "utf8")).toBe("{not json");
  });

  it("keeps the readable rows of a partially corrupt registry hidden and frozen", async () => {
    await mkdir(join(root, "side-chat"), { recursive: true });
    await writeFile(
      join(root, "side-chat", "sidecars.json"),
      JSON.stringify([sidecar(), { sourceThreadId: "" }]),
      "utf8",
    );

    const reopened = new SideChatSidecarStore(root);
    await reopened.hydrate();

    // The row that decoded still hides its Chat thread, so it does not
    // reappear in Recents…
    expect(reopened.list()).toEqual([sidecar()]);
    expect([...reopened.hiddenThreadIds()]).toEqual(["00000000-0000-4000-8000-000000000201"]);
    // …and the row that did not decode is not treated as absent: nothing may
    // be recorded over a registry whose contents are only partly known.
    await expect(
      reopened.record(
        sidecar({
          sourceThreadId: decodeMentionableThreadId("00000000-0000-4000-8000-000000000102"),
          sidecarThreadId: decodeChatThreadId("00000000-0000-4000-8000-000000000202"),
        }),
      ),
    ).rejects.toThrow(/registry/i);
  });

  it("reopens a link the corrupt registry still holds without writing", async () => {
    await mkdir(join(root, "side-chat"), { recursive: true });
    const payload = JSON.stringify([sidecar(), { sourceThreadId: "" }]);
    await writeFile(join(root, "side-chat", "sidecars.json"), payload, "utf8");

    const reopened = new SideChatSidecarStore(root);
    await reopened.hydrate();

    // Reopening an intact link needs no write, so it stays available.
    await expect(reopened.record(sidecar())).resolves.toEqual(sidecar());
    expect(await readFile(join(root, "side-chat", "sidecars.json"), "utf8")).toBe(payload);
  });

  it("leaves no temporary file behind after a flush", async () => {
    await store.record(sidecar());

    const persisted = JSON.parse(await readFile(join(root, "side-chat", "sidecars.json"), "utf8"));
    expect(persisted).toHaveLength(1);
    await expect(readFile(join(root, "side-chat", "sidecars.json.tmp"), "utf8")).rejects.toThrow();
  });
});
