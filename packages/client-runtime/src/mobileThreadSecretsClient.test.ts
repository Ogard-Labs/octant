import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import {
  answerMobileThreadSecretCard,
  listMobileThreadSecretCards,
} from "./mobileThreadSecretsClient";

const threadId = "66000000-0000-4000-8000-000000000001";
const answer = {
  id: "66000000-0000-4000-8000-000000000002",
  action: "decline",
} as const;
const host = (reply: () => Response) => {
  const fetch = vi.fn(async (_request: { readonly body?: unknown; readonly path: string }) =>
    reply(),
  );
  const transport = {
    hostId: "66000000-0000-4000-8000-0000000000ff",
    authenticatedFetch: fetch as unknown as MobileRemoteTransport["authenticatedFetch"],
  };
  return { fetch, transport };
};

describe("secret cards on a paired device", () => {
  it("reads one thread's cards and sends one answer on the device's own path", async () => {
    const { fetch, transport } = host(() => Response.json({ requests: [], active: [] }));
    expect(await listMobileThreadSecretCards({ transport, threadId })).toEqual([]);
    const taken = host(() => Response.json({ status: "accepted" }));
    expect(
      await answerMobileThreadSecretCard({ transport: taken.transport, threadId, answer }),
    ).toEqual({ status: "accepted" });
    const sent = [...fetch.mock.calls, ...taken.fetch.mock.calls].map(([request]) => [
      request.path,
      JSON.parse(String(request.body)),
    ]);
    expect(sent).toEqual([
      ["/api/thread-secrets/paired", { kind: "list", threadId }],
      ["/api/thread-secrets/paired", { kind: "answer", threadId, answer }],
    ]);
  });

  it("tells an answer the host did not take from one whose outcome is not known", async () => {
    const refused = host(() => Response.json({}, { status: 403 }));
    expect(
      await answerMobileThreadSecretCard({ transport: refused.transport, threadId, answer }),
    ).toEqual({ status: "not-taken" });
    await expect(
      listMobileThreadSecretCards({ transport: refused.transport, threadId }),
    ).rejects.toThrow();
    const broken = host(() => Response.json({}, { status: 502 }));
    await expect(
      answerMobileThreadSecretCard({ transport: broken.transport, threadId, answer }),
    ).rejects.toThrow();
  });
});
