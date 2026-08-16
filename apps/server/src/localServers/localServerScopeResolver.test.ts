import { describe, expect, it, vi } from "vitest";
import type {
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeThread,
  CodeThreadId,
  ProjectId,
  WindowId,
} from "@octant/contracts";
import { createCodeThreadLocalServerScopeResolver } from "./localServerScopeResolver";

const windowId = "44444444-4444-4444-8444-444444444444" as WindowId;
const threadId = "11111111-1111-4111-8111-111111111111" as CodeThreadId;
const projectId = "22222222-2222-4222-8222-222222222222" as ProjectId;
const checkoutId = "33333333-3333-4333-8333-333333333333" as CodeCheckoutId;

const thread = {
  id: threadId,
  projectId,
  checkoutId,
  executionPolicy: "plan",
} as unknown as CodeThread;

const checkout = { id: checkoutId } as unknown as CodeCheckoutIdentity;

function resolver(
  overrides: {
    readonly thread?: CodeThread | undefined;
    readonly root?: string | undefined;
    readonly projectType?: "code" | "work";
    readonly ownedPids?: ReadonlySet<number>;
  } = {},
) {
  return createCodeThreadLocalServerScopeResolver({
    projects: {
      bootstrap: vi.fn().mockResolvedValue({
        active: [
          {
            id: projectId,
            type: overrides.projectType ?? "code",
            lifecycle: "active",
            binding: { canonicalRoot: "/repo" },
          },
          { id: "other", type: "code", lifecycle: "active", binding: { canonicalRoot: "/other" } },
        ],
        archived: [],
        availability: [],
        memory: [],
      }),
    } as never,
    source: {
      readThread: () => ("thread" in overrides ? overrides.thread : thread),
      readCheckout: () => checkout,
      resolveCheckoutRoot: async () => ("root" in overrides ? overrides.root : "/repo"),
      ownedPids: () => overrides.ownedPids ?? new Set<number>(),
    },
  });
}

describe("code thread local server scope", () => {
  it("resolves the thread posture and the visible user project roots", async () => {
    const scope = await resolver({ ownedPids: new Set([4213]) }).resolve(
      windowId,
      threadId,
      projectId,
    );
    expect(scope).toEqual({
      threadId,
      projectId,
      currentCheckoutRoot: "/repo",
      userProjectRoots: ["/repo", "/other"],
      posture: "plan",
      ownedPids: new Set([4213]),
    });
  });

  it("fails closed when the thread is missing or belongs to another Project", async () => {
    expect(
      await resolver({ thread: undefined }).resolve(windowId, threadId, projectId),
    ).toBeUndefined();
    expect(
      await resolver().resolve(
        windowId,
        threadId,
        "99999999-9999-4999-8999-999999999999" as ProjectId,
      ),
    ).toBeUndefined();
  });

  it("fails closed for a non-Code Project and for an unresolvable checkout root", async () => {
    expect(
      await resolver({ projectType: "work" }).resolve(windowId, threadId, projectId),
    ).toBeUndefined();
    expect(
      await resolver({ root: undefined }).resolve(windowId, threadId, projectId),
    ).toBeUndefined();
  });
});
