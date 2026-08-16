import { describe, expect, it, vi } from "vitest";
import {
  mergeFailureMessage,
  mergeMobilePullRequest,
  observeMobilePullRequest,
} from "./mobileCodeOperationsClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const threadId = "84000000-0000-4000-8000-000000000001";
const checkoutId = "85000000-0000-4000-8000-000000000001";
const headSha = "c".repeat(40);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mobileCodeOperationsClient", () => {
  it("observes a pull request over authenticated remote transport", async () => {
    const fetch = vi.fn(async ({ body }: { body?: string }) => {
      const command = JSON.parse(body ?? "{}") as { operationId: string; kind: string };
      expect(command.kind).toBe("observe-pull-request");
      return jsonResponse({
        kind: "pull-request-review",
        operationId: command.operationId,
        state: "none",
        freshness: "fresh",
      });
    });

    const transport = {
      hostId: "host-1",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    await expect(
      observeMobilePullRequest({ transport, threadId, checkoutId }),
    ).resolves.toMatchObject({ kind: "pull-request-review", state: "none" });
  });

  it("merges with confirmation echo and maps conflict failures", async () => {
    const fetch = vi.fn(async ({ body }: { body?: string }) => {
      const command = JSON.parse(body ?? "{}") as {
        operationId: string;
        kind: string;
        confirmation: { number: number };
      };
      expect(command.kind).toBe("merge-pull-request");
      expect(command.confirmation.number).toBe(42);
      return jsonResponse({
        kind: "pull-request-state",
        operationId: command.operationId,
        state: "failed",
        failureCode: "conflict",
      });
    });

    const transport = {
      hostId: "host-1",
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    const result = await mergeMobilePullRequest({
      transport,
      threadId,
      checkoutId,
      expectedHeadSha: headSha,
      mergeMethod: "squash",
      confirmation: {
        number: 42,
        baseRepository: "octocat/octant",
        baseBranch: "development",
        headBranch: "feature/mobile",
        mergeMethod: "squash",
        expectedHeadSha: headSha,
      },
      authorization: { kind: "full-access" },
      idempotencyKey: "mobile-merge-1",
    });

    expect(result.state).toBe("failed");
    expect(mergeFailureMessage(result)).toContain("conflicts");
  });
});
