import {
  decodeCodeCheckoutId,
  decodeCodeFileId,
  decodeCodeReviewFindingId,
  decodeCodeReviewFinding,
  decodeCodeRelativePath,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import {
  ReviewFindingService,
  ReviewFindingServiceError,
  type ReviewFindingPersistencePort,
} from "./reviewFindingService";

const ids = {
  window: decodeWindowId("70000000-0000-4000-8000-000000000001"),
  project: decodeProjectId("70000000-0000-4000-8000-000000000002"),
  thread: decodeCodeThreadId("70000000-0000-4000-8000-000000000003"),
  checkout: decodeCodeCheckoutId("70000000-0000-4000-8000-000000000004"),
  file: decodeCodeFileId("70000000-0000-4000-8000-000000000005"),
  finding: decodeCodeReviewFindingId("70000000-0000-4000-8000-000000000006"),
} as const;
const now = "2026-07-21T00:00:00.000Z";
const digest = "a".repeat(64);

function fixture(options: { readonly authorized?: boolean } = {}) {
  const records = new Map<string, ReturnType<typeof decodeCodeReviewFinding>>();
  const persistence: ReviewFindingPersistencePort = {
    journal: { append: vi.fn() },
    readCodeThread: vi.fn(
      () => ({ id: ids.thread, projectId: ids.project, checkoutId: ids.checkout }) as never,
    ),
    readReviewFinding: vi.fn((id) => records.get(String(id))),
    readReviewFindings: vi.fn((threadId) =>
      [...records.values()].filter((finding) => finding.threadId === threadId),
    ),
  };
  const files = {
    resolve: vi.fn(
      () =>
        ({
          threadId: ids.thread,
          checkoutId: ids.checkout,
          path: input.path,
          digest,
        }) as never,
    ),
  };
  const service = new ReviewFindingService({
    persistence,
    access: { canAccessProject: vi.fn(async () => options.authorized ?? true) },
    files,
    uuid: () => ids.finding,
    clock: () => now,
  });
  return { service, persistence, records, files };
}

const input = {
  id: ids.finding,
  threadId: ids.thread,
  checkoutId: ids.checkout,
  fileId: ids.file,
  path: decodeCodeRelativePath("src/code.ts"),
  fileDigest: digest,
  location: { kind: "selection", startLine: 4, startColumn: 2, endLine: 5, endColumn: 8 },
  severity: "warning",
  author: { kind: "local-user", actorId: "local-user" },
  provenance: { kind: "manual" },
  summary: "Handle the interrupted state.",
} as const;

describe("ReviewFindingService", () => {
  it("journals one authorized strict local finding without publishing it", async () => {
    const { service, persistence } = fixture();

    await expect(service.create(ids.window, input)).resolves.toMatchObject({
      state: "open",
      version: 1,
      ...input,
    });
    expect(persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregate: { aggregateType: "code-review-finding", aggregateId: ids.finding },
        expectedVersion: 0,
        events: [
          expect.objectContaining({
            eventName: "code.review-finding-updated@1",
            payload: expect.objectContaining({
              kind: "review-finding-updated",
              finding: expect.objectContaining({ id: ids.finding, state: "open", version: 1 }),
            }),
          }),
        ],
      }),
    );
    expect(service).not.toHaveProperty("publish");
  });

  it("rejects unauthorized, missing-thread, and malformed finding inputs before append", async () => {
    const unauthorized = fixture({ authorized: false });
    await expect(unauthorized.service.create(ids.window, input)).rejects.toMatchObject({
      failure: "unauthorized",
    });
    expect(unauthorized.persistence.journal.append).not.toHaveBeenCalled();

    const missing = fixture();
    vi.mocked(missing.persistence.readCodeThread).mockReturnValue(undefined);
    await expect(missing.service.create(ids.window, input)).rejects.toMatchObject({
      failure: "invalid",
    });

    const malformed = fixture();
    await expect(
      malformed.service.create(ids.window, {
        ...input,
        path: "../escape",
      } as never),
    ).rejects.toBeInstanceOf(ReviewFindingServiceError);
    await expect(
      malformed.service.create(ids.window, {
        ...input,
        location: { kind: "selection", startLine: 5, startColumn: 1, endLine: 4, endColumn: 1 },
      } as never),
    ).rejects.toMatchObject({ failure: "invalid" });
  });

  it("rejects a missing, unrelated, or stale authoritative file reference", async () => {
    for (const file of [
      undefined,
      {
        id: ids.file,
        threadId: decodeCodeThreadId("70000000-0000-4000-8000-000000000099"),
        checkoutId: ids.checkout,
        path: input.path,
        digest,
      },
      {
        id: ids.file,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        path: input.path,
        digest: "b".repeat(64),
      },
    ]) {
      const instance = fixture();
      vi.mocked(instance.files.resolve).mockReturnValue(file as never);
      await expect(instance.service.create(ids.window, input)).rejects.toMatchObject({
        failure: "invalid",
      });
      expect(instance.persistence.journal.append).not.toHaveBeenCalled();
    }
  });

  it("updates state with optimistic versions while preserving immutable provenance", async () => {
    const { service, persistence, records } = fixture();
    const existing = decodeCodeReviewFinding({
      ...input,
      state: "open",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    records.set(String(ids.finding), existing);

    await expect(
      service.changeState(ids.window, {
        findingId: ids.finding,
        expectedVersion: 1,
        state: "resolved",
      }),
    ).resolves.toMatchObject({ state: "resolved", version: 2, provenance: input.provenance });
    expect(persistence.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        events: [
          expect.objectContaining({
            payload: expect.objectContaining({
              finding: expect.objectContaining({ state: "resolved", version: 2 }),
            }),
          }),
        ],
      }),
    );

    await expect(
      service.changeState(ids.window, {
        findingId: ids.finding,
        expectedVersion: 2,
        state: "dismissed",
      }),
    ).rejects.toMatchObject({ failure: "stale" });
  });

  it("normalizes a journal concurrency race to stale", async () => {
    const { service, persistence, records } = fixture();
    records.set(
      String(ids.finding),
      decodeCodeReviewFinding({
        ...input,
        state: "open",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    vi.mocked(persistence.journal.append).mockImplementation(() => {
      throw new ConcurrencyConflict({
        aggregateType: "code-review-finding",
        aggregateId: ids.finding,
        expectedVersion: 1,
        actualVersion: 2,
      });
    });

    await expect(
      service.changeState(ids.window, {
        findingId: ids.finding,
        expectedVersion: 1,
        state: "resolved",
      }),
    ).rejects.toMatchObject({ failure: "stale" });
  });

  it("normalizes a concurrent create race to stale", async () => {
    const { service, persistence } = fixture();
    vi.mocked(persistence.journal.append).mockImplementation(() => {
      throw new ConcurrencyConflict({
        aggregateType: "code-review-finding",
        aggregateId: ids.finding,
        expectedVersion: 0,
        actualVersion: 1,
      });
    });

    await expect(service.create(ids.window, input)).rejects.toMatchObject({ failure: "stale" });
  });

  it("lists findings only after authorizing the owning thread Project", async () => {
    const allowed = fixture();
    allowed.records.set(
      String(ids.finding),
      decodeCodeReviewFinding({
        ...input,
        state: "open",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await expect(allowed.service.list(ids.window, ids.thread)).resolves.toHaveLength(1);

    const denied = fixture({ authorized: false });
    await expect(denied.service.list(ids.window, ids.thread)).rejects.toMatchObject({
      failure: "unauthorized",
    });
  });
});
