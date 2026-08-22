import { describe, expect, it, vi } from "vitest";
import { observeMobilePullRequest } from "./mobileCodeOperationsClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const threadId = "84000000-0000-4000-8000-000000000001";
const checkoutId = "85000000-0000-4000-8000-000000000001";

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
});
