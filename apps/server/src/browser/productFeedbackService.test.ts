import { decodeProductFeedbackNote, type ProductFeedbackNote } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ProductFeedbackError,
  ProductFeedbackService,
  type ProductFeedbackServiceOptions,
} from "./productFeedbackService";

const ids = {
  note: "11111111-1111-4111-8111-111111111111",
  thread: "22222222-2222-4222-8222-222222222222",
  context: "33333333-3333-4333-8333-333333333333",
  content: "44444444-4444-4444-8444-444444444444",
  actor: "55555555-5555-4555-8555-555555555555",
  window: "66666666-6666-4666-8666-666666666666",
  operation: "77777777-7777-4777-8777-777777777777",
};

const now = "2026-08-18T09:00:00.000Z";
const windowId = ids.window as never;
const crop = `data:image/jpeg;base64,${"A".repeat(32)}=`;

const described = {
  status: "described" as const,
  element: {
    selector: "main > button:nth-of-type(2)",
    role: "button",
    accessibleName: "Save changes",
    text: "Save changes",
    bounds: { x: 0.25, y: 0.5, width: 0.1, height: 0.05 },
  },
  cropDataUrl: crop,
  url: "https://localhost:5173/settings",
  title: "Settings",
};

const capture = {
  kind: "capture-product-feedback",
  threadId: ids.thread,
  mode: "code",
  contextId: ids.context,
  point: { x: 0.3, y: 0.52 },
  comment: "This button is off by a few pixels.",
} as const;

function storedNote(overrides: Record<string, unknown> = {}): ProductFeedbackNote {
  return decodeProductFeedbackNote({
    id: ids.note,
    threadId: ids.thread,
    mode: "code",
    comment: "This button is off by a few pixels.",
    element: {
      kind: "browser-element",
      selector: "main > button:nth-of-type(2)",
      bounds: { x: 0.25, y: 0.5, width: 0.1, height: 0.05 },
    },
    provenance: {
      comment: { origin: "user", sourceLabel: "product-feedback-comment" },
      element: { origin: "external-content", sourceLabel: "browser-page" },
    },
    lifecycle: "pending",
    capturedAt: now,
    version: 1,
    updatedAt: now,
    ...overrides,
  });
}

function harness(
  options: {
    readonly notes?: ReadonlyArray<ProductFeedbackNote>;
    readonly observation?: Awaited<
      ReturnType<ProductFeedbackServiceOptions["browser"]["describePoint"]>
    >;
    readonly canAccess?: boolean;
    readonly cropThrows?: boolean;
    readonly recordExternalContentIngestion?: ProductFeedbackServiceOptions["recordExternalContentIngestion"];
  } = {},
) {
  const stored = new Map<string, ProductFeedbackNote>(
    (options.notes ?? []).map((note) => [String(note.id), note]),
  );
  const journal = { append: vi.fn() };
  const describePoint = vi.fn(async () => options.observation ?? described);
  const service = new ProductFeedbackService({
    journal,
    browser: { describePoint: describePoint as never },
    crops: {
      put: vi.fn(() => {
        if (options.cropThrows === true) throw new Error("no room");
        return { contentId: ids.content, digest: "a".repeat(64), byteLength: 64 };
      }),
      read: () => crop,
    },
    readNote: (noteId) => stored.get(String(noteId)),
    readNotes: (threadId) =>
      [...stored.values()].filter((note) => String(note.threadId) === String(threadId)),
    canAccessThread: async () => options.canAccess ?? true,
    ...(options.recordExternalContentIngestion === undefined
      ? {}
      : { recordExternalContentIngestion: options.recordExternalContentIngestion }),
    uuid: () => ids.note,
    clock: () => now,
    actor: { kind: "local-user", actorId: ids.actor as never },
  });
  return { service, journal, describePoint, stored };
}

describe("pointing at the running product", () => {
  it("resolves the element on the host and never takes one from the caller", async () => {
    const { service, describePoint } = harness();

    const result = await service.execute(windowId, capture);

    expect(describePoint).toHaveBeenCalledWith({
      windowId,
      threadId: ids.thread,
      contextId: ids.context,
      point: { x: 0.3, y: 0.52 },
    });
    expect(result).toMatchObject({
      kind: "feedback-captured",
      note: {
        element: { kind: "browser-element", selector: "main > button:nth-of-type(2)" },
        crop: { contentId: ids.content },
      },
    });
  });

  it("credits the comment to the user and the element to the page", async () => {
    const { service } = harness();

    const result = await service.execute(windowId, capture);

    expect(result).toMatchObject({
      note: {
        provenance: {
          comment: { origin: "user" },
          element: { origin: "external-content", sourceLabel: "browser-page" },
        },
      },
    });
  });

  it("records the pointed-at page as thread-lifetime external content once", async () => {
    const recordExternalContentIngestion = vi.fn(() => ({
      kind: "recorded" as const,
      taint: { externalContentIngested: true, ingestedSources: ["browser-page"] },
    }));
    const { service } = harness({ recordExternalContentIngestion });

    await service.execute(windowId, capture);

    expect(recordExternalContentIngestion).toHaveBeenCalledTimes(1);
    expect(recordExternalContentIngestion).toHaveBeenCalledWith({
      threadId: ids.thread,
      provenance: { origin: "external-content", sourceLabel: "browser-page" },
      contentReference: ids.note,
      correlationId: ids.note,
      authorized: true,
    });
  });

  it("refuses, and journals nothing, when the host will not show this thread", async () => {
    const { service, journal, describePoint } = harness({ canAccess: false });

    expect(await service.execute(windowId, capture)).toEqual({
      kind: "feedback-refused",
      reason: "thread-unavailable",
    });
    // The authority check runs before the capture, so a refused caller never
    // causes the host to read its own page.
    expect(describePoint).not.toHaveBeenCalled();
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("refuses when the surface cannot be read at all", async () => {
    const { service } = harness({ observation: { status: "unavailable" } });

    expect(await service.execute(windowId, capture)).toEqual({
      kind: "feedback-refused",
      reason: "surface-unavailable",
    });
  });

  it("refuses when the tap landed on nothing", async () => {
    const { service } = harness({ observation: { status: "no-element" } });

    expect(await service.execute(windowId, capture)).toEqual({
      kind: "feedback-refused",
      reason: "element-unavailable",
    });
  });

  it("keeps the note when its picture could not be stored", async () => {
    const { service } = harness({ cropThrows: true });

    const result = await service.execute(windowId, capture);

    expect(result.kind).toBe("feedback-captured");
    expect(result.kind === "feedback-captured" && result.note.crop).toBeUndefined();
  });

  it("stops taking notes once the thread's queue is full", async () => {
    const notes = Array.from({ length: 8 }, (_entry, index) =>
      storedNote({ id: `1111111${String(index)}-1111-4111-8111-111111111111` }),
    );
    const { service, journal } = harness({ notes });

    expect(await service.execute(windowId, capture)).toEqual({
      kind: "feedback-refused",
      reason: "note-limit-reached",
    });
    expect(journal.append).not.toHaveBeenCalled();
  });
});

describe("handing a thread's notes to the turn about to run", () => {
  it("marks each note delivered against the turn that took it", async () => {
    const { service, journal } = harness({ notes: [storedNote()] });

    const delivered = service.deliver({ threadId: ids.thread, operationId: ids.operation });

    expect(delivered.map((note) => note.lifecycle)).toEqual(["delivered"]);
    const append = journal.append.mock.calls[0]?.[0] as {
      events: ReadonlyArray<{ eventName: string; payload: { operationId: string } }>;
    };
    expect(append.events[0]?.eventName).toBe("feedback.note-delivered@1");
    expect(append.events[0]?.payload.operationId).toBe(ids.operation);
  });

  it("takes nothing that was already carried or thrown away", async () => {
    const { service } = harness({
      notes: [
        storedNote({ id: ids.note, lifecycle: "delivered", deliveredAt: now, version: 2 }),
        storedNote({
          id: "88888888-8888-4888-8888-888888888888",
          lifecycle: "discarded",
          version: 2,
        }),
      ],
    });

    expect(service.deliver({ threadId: ids.thread, operationId: ids.operation })).toEqual([]);
  });

  it("carries no note the journal would not take", async () => {
    const { service, journal } = harness({ notes: [storedNote()] });
    journal.append.mockImplementation(() => {
      throw new Error("conflict");
    });

    expect(service.deliver({ threadId: ids.thread, operationId: ids.operation })).toEqual([]);
  });
});

describe("throwing a note away", () => {
  it("refuses a discard computed against a stale view", async () => {
    const { service } = harness({ notes: [storedNote()] });

    await expect(
      service.execute(windowId, {
        kind: "discard-product-feedback",
        noteId: ids.note,
        expectedVersion: 5,
      }),
    ).rejects.toBeInstanceOf(ProductFeedbackError);
  });

  it("keeps the note readable as discarded", async () => {
    const { service } = harness({ notes: [storedNote()] });

    const result = await service.execute(windowId, {
      kind: "discard-product-feedback",
      noteId: ids.note,
      expectedVersion: 1,
    });

    expect(result).toMatchObject({ kind: "feedback-discarded", note: { lifecycle: "discarded" } });
  });
});
