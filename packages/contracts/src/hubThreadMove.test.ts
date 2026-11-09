import { describe, expect, it } from "vitest";
import {
  decodeHandoverNotice,
  decodeThreadMoveDestinationState,
  decodeThreadMoveOffer,
  decodeThreadMoveSizes,
  THREAD_MOVE_EVENT_NAMES,
  THREAD_MOVE_FAILURE_REASONS,
} from "./hubThreadMove";
import { decodePeerGrant } from "./hubAndSpokes";

const uuid = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const sha = "a".repeat(64);

const offer = (overrides: Record<string, unknown> = {}) => ({
  moveId: uuid(1),
  source: { mode: "code", threadId: uuid(2) },
  title: "Move threads between computers",
  destinationProjectId: uuid(3),
  repositoryRemotes: ["git@github.com:Ogard-Labs/octant.git"],
  manifest: {
    parts: [
      { partId: "bundle", kind: "thread-bundle", bytes: 1200, sha256: sha },
      { partId: "git", kind: "git-bundle", bytes: 5_000_000_000, sha256: sha },
    ],
  },
  ...overrides,
});

describe("a move offer", () => {
  it("decodes a Code offer of any size", () => {
    expect(decodeThreadMoveOffer(offer()).manifest.parts).toHaveLength(2);
  });

  it("refuses a Work or Code offer that names no destination Project", () => {
    expect(() => decodeThreadMoveOffer(offer({ destinationProjectId: undefined }))).toThrow(
      /moves into a Project/,
    );
    expect(() =>
      decodeThreadMoveOffer(
        offer({ source: { mode: "work", threadId: uuid(2) }, destinationProjectId: undefined }),
      ),
    ).toThrow(/moves into a Project/);
  });

  it("lets a Chat thread move into no Project", () => {
    const chat = decodeThreadMoveOffer(
      offer({
        source: { mode: "chat", threadId: uuid(2) },
        destinationProjectId: undefined,
        repositoryRemotes: undefined,
      }),
    );
    expect(chat.destinationProjectId).toBeUndefined();
  });

  it("refuses a Code offer that does not name its repository", () => {
    expect(() => decodeThreadMoveOffer(offer({ repositoryRemotes: [] }))).toThrow(
      /names the repository/,
    );
  });

  it("refuses a manifest with repeated parts or other than one thread bundle", () => {
    expect(() =>
      decodeThreadMoveOffer(
        offer({
          manifest: {
            parts: [
              { partId: "bundle", kind: "thread-bundle", bytes: 1, sha256: sha },
              { partId: "bundle", kind: "attachment", bytes: 1, sha256: sha },
            ],
          },
        }),
      ),
    ).toThrow(/must not repeat/);
    expect(() =>
      decodeThreadMoveOffer(
        offer({
          manifest: { parts: [{ partId: "git", kind: "git-bundle", bytes: 1, sha256: sha }] },
        }),
      ),
    ).toThrow(/exactly one thread bundle/);
  });

  it("refuses fields it does not know, so nothing rides along unchecked", () => {
    expect(() => decodeThreadMoveOffer(offer({ credentials: "secret" }))).toThrow();
  });
});

describe("the destination's state for a move", () => {
  it("names acknowledged chunks while receiving so a cut transfer resumes", () => {
    const state = decodeThreadMoveDestinationState({
      state: "receiving",
      moveId: uuid(1),
      acknowledged: [{ partId: "git", chunks: 12 }],
    });
    expect(state.state).toBe("receiving");
  });

  it("names the new thread once it arrived or committed", () => {
    expect(() =>
      decodeThreadMoveDestinationState({ state: "committed", moveId: uuid(1) }),
    ).toThrow();
  });
});

describe("handover notices and failure reasons", () => {
  it("carries only where to continue, never the work", () => {
    expect(() =>
      decodeHandoverNotice({
        handoverId: uuid(4),
        title: "Fix the page",
        repositoryRemote: "https://github.com/Ogard-Labs/octant",
        branch: "octant/handover/fix-the-page-44444444",
        note: "the note travels in the commit, not here",
      }),
    ).toThrow();
  });

  it("lists every reason a move can fail, once", () => {
    expect(new Set(THREAD_MOVE_FAILURE_REASONS).size).toBe(THREAD_MOVE_FAILURE_REASONS.length);
    expect(THREAD_MOVE_EVENT_NAMES.moveFailed).toBe("thread.move-failed@1");
  });
});

describe("sizes before a move", () => {
  it("reads a thread it could not measure as unknown and refuses a rate that would divide by zero", () => {
    const sizes = (rate: Record<string, unknown>) => ({
      status: "read",
      rate,
      rows: [
        {
          thread: { mode: "code", threadId: uuid(2) },
          size: {
            status: "measured",
            bytes: 5_000_000_000,
            parts: [{ kind: "git-bundle", bytes: 5_000_000_000 }],
          },
        },
        { thread: { mode: "chat", threadId: uuid(3) }, size: { status: "unknown" } },
      ],
    });
    expect(
      decodeThreadMoveSizes(sizes({ basis: "assumed", bytesPerSecond: 1_048_576 })).rows[1]?.size,
    ).toEqual({ status: "unknown" });
    expect(() => decodeThreadMoveSizes(sizes({ basis: "measured", bytesPerSecond: 0 }))).toThrow();
  });
});

describe("the Move in grant item", () => {
  it("reads as off when a stored grant predates it", () => {
    expect(decodePeerGrant({ memberId: uuid(5), readStatus: true }).moveIn).toBeUndefined();
    expect(decodePeerGrant({ memberId: uuid(5), readStatus: true, moveIn: true }).moveIn).toBe(
      true,
    );
  });
});
