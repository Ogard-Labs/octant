import { describe, expect, it } from "vitest";
import { createNativeHarnessClient, NativeHarnessClientFailure } from "./nativeHarnessClient";

const baseUrl = "http://127.0.0.1:4100";

function client(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return createNativeHarnessClient({
    baseUrl,
    fetch: handler as typeof globalThis.fetch,
    windowCapability: "capability",
  });
}

describe("native harness client", () => {
  it("takes only the steering notes the host assigned to this caller", async () => {
    const note = {
      id: "00000000-0000-4000-8000-000000000021",
      text: "Check the small fix",
      status: "queued",
      at: "2026-10-16T12:06:00.000Z",
    };
    const subject = client(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/api/native-harness/sessions/thread/steering`);
      expect(JSON.parse(String(init?.body))).toEqual({ kind: "take" });
      expect(new Headers(init?.headers).get("x-octant-window-capability")).toBe("capability");
      return Response.json({ view: null, taken: [note] });
    });
    expect(await subject.takeSteering("thread")).toEqual({ taken: [note] });
  });

  it("refuses a take response that does not identify the claimed notes", async () => {
    const subject = client(async () => Response.json({ view: null }));
    await expect(subject.takeSteering("thread")).rejects.toThrow();
  });

  it("reads the routing table with the window capability and decodes it", async () => {
    const seen: string[] = [];
    const subject = client(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push(`${init?.method} ${String(input)} ${headers.get("x-octant-window-capability")}`);
      return Response.json({
        settings: {
          configuration: { slots: [], jobSlots: [{ job: "lead", slotId: "default" }] },
          version: 2,
          updatedAt: "2026-09-05T12:00:00.000Z",
        },
      });
    });
    const settings = await subject.routing();
    expect(settings.version).toBe(2);
    expect(seen).toEqual([`GET ${baseUrl}/api/native-harness/routing capability`]);
  });

  it("returns a refused update as a value rather than throwing", async () => {
    const subject = client(async () =>
      Response.json(
        { kind: "routing-refused", reason: "stale-version", message: "Reload first." },
        { status: 409 },
      ),
    );
    const result = await subject.updateRouting({
      configuration: { slots: [], jobSlots: [] },
      expectedVersion: 0,
    });
    expect(result).toMatchObject({ kind: "routing-refused", reason: "stale-version" });
  });

  it("reports an unauthorized session read as a typed failure", async () => {
    const subject = client(async () => Response.json({ error: "no" }, { status: 401 }));
    await expect(subject.session("00000000-0000-4000-8000-000000000020")).rejects.toBeInstanceOf(
      NativeHarnessClientFailure,
    );
  });

  it("returns a refused network answer as a value the card can show", async () => {
    let seen = "";
    const subject = client(async (input, init) => {
      seen = `${init?.method} ${String(input)}`;
      return Response.json(
        {
          kind: "tool-egress-refused",
          reason: "needs-local-window",
          message: "A Project rule needs you at this computer.",
        },
        { status: 409 },
      );
    });
    const result = await subject.egressCommand("00000000-0000-4000-8000-000000000020", {
      kind: "grant-rules",
      grants: [
        { host: "registry.npmjs.org", port: 443, choice: { kind: "project", lifetime: "7d" } },
      ],
      declineProposalIds: [],
    });
    expect(result).toMatchObject({ kind: "tool-egress-refused", reason: "needs-local-window" });
    expect(seen).toBe(
      `POST ${baseUrl}/api/native-harness/egress/threads/00000000-0000-4000-8000-000000000020`,
    );
  });

  it("treats a thread without a session as null, not a decode failure", async () => {
    const subject = client(async () => Response.json({ view: null }));
    expect(await subject.session("00000000-0000-4000-8000-000000000020")).toBeNull();
  });

  it("sends a follow-up activation with its explicit confirmation", async () => {
    let body: unknown;
    const subject = client(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        kind: "follow-up-activated",
        suggestionId: "00000000-0000-4000-8000-000000000041",
        created: { kind: "same-thread", threadId: "00000000-0000-4000-8000-000000000020" },
      });
    });
    const result = await subject.activateFollowUp("00000000-0000-4000-8000-000000000020", {
      turnId: "00000000-0000-4000-8000-000000000031" as never,
      suggestionId: "00000000-0000-4000-8000-000000000041" as never,
      confirmed: true,
    });
    expect(body).toMatchObject({ confirmed: true });
    expect(result.kind).toBe("follow-up-activated");
  });
});
