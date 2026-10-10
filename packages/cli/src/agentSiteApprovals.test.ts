import { describe, expect, it } from "vitest";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";
import { askSiteApproval, listAgentSiteApprovals } from "./agentSiteApprovals";

const threadId = "00000000-0000-4000-8000-000000000101";
const otherThreadId = "00000000-0000-4000-8000-000000000102";
const projectId = "20000000-0000-4000-8000-000000000001";
const checkoutId = "30000000-0000-4000-8000-000000000001";
const approvalId = "40000000-0000-4000-8000-000000000001";
const requestedAt = "2026-10-09T12:00:00.000Z";

function session(
  answer: (request: LocalControlRequest) => { status: number; body: unknown },
): OpenedLocalControlSession & { readonly seen: LocalControlRequest[] } {
  const seen: LocalControlRequest[] = [];
  return {
    kind: "opened",
    windowId: "window",
    seen,
    send: async (request) => {
      seen.push(request);
      return answer(request);
    },
    close: async () => undefined,
  };
}

function sink() {
  const chunks: string[] = [];
  return { write: (chunk: string) => chunks.push(chunk), text: () => chunks.join("") };
}

function lines(...answers: ReadonlyArray<string>) {
  const queue = [...answers];
  return async () => queue.shift();
}

/** A Work turn's Browser call waiting on example.com, as the app's Browser route lists it. */
function workHost(
  decision: { status: number; body: unknown } = { status: 200, body: { accepted: true } },
) {
  return session((request) => {
    if (request.path !== "/api/browser/approvals") return { status: 404, body: {} };
    if ((request.body as { kind?: unknown }).kind === "list") {
      return {
        status: 200,
        body: [
          { approvalId, threadId, mode: "work", origin: "https://example.com", requestedAt },
          {
            approvalId: "40000000-0000-4000-8000-000000000002",
            threadId: otherThreadId,
            mode: "work",
            origin: "https://elsewhere.test",
            requestedAt,
          },
        ],
      };
    }
    return decision;
  });
}

/** A Code turn's Browser call waiting on example.com, as the host's pending-request list shows it. */
function codeHost(result: unknown = { kind: "provider-turn-state", state: "running" }) {
  return session((request) => {
    if (request.path === "/api/pending-requests") {
      return {
        status: 200,
        body: {
          requests: [
            {
              mode: "code",
              kind: "approval",
              projectId,
              threadId,
              threadTitle: "Fix the docs site",
              requestedAt,
              text: "Allow this thread to use an isolated browser session at https://example.com? Shell and file access stay unchanged.",
              browserOrigin: "https://example.com",
              answer: { threadId, checkoutId, approvalId },
            },
            {
              mode: "code",
              kind: "approval",
              projectId,
              threadId,
              threadTitle: "Fix the docs site",
              requestedAt,
              text: "Run rm -rf build?",
              answer: { threadId, checkoutId, approvalId: "40000000-0000-4000-8000-000000000009" },
            },
          ],
          truncated: false,
        },
      };
    }
    if (request.path === "/api/code/commands") return { status: 200, body: result };
    return { status: 404, body: {} };
  });
}

async function onlyAsk(host: OpenedLocalControlSession, mode: "work" | "code") {
  const [approval] = await listAgentSiteApprovals(host, mode, threadId);
  if (approval === undefined) throw new Error("The host listed no site ask.");
  return approval;
}

describe("site approvals in the terminal", () => {
  it("lists only this thread's Browser site asks from the route the app's Work view polls", async () => {
    const host = workHost();
    const listed = await listAgentSiteApprovals(host, "work", threadId);
    expect(listed).toEqual([
      expect.objectContaining({ id: approvalId, mode: "work", origin: "https://example.com" }),
    ]);
    expect(host.seen[0]).toMatchObject({
      path: "/api/browser/approvals",
      method: "POST",
      body: { kind: "list" },
    });
  });

  it("lists only a Code turn's site asks from the host's pending requests and none for Chat", async () => {
    const host = codeHost();
    // The provider's own approval to run a command is never offered as a site ask.
    expect(await listAgentSiteApprovals(host, "code", threadId)).toEqual([
      expect.objectContaining({ id: approvalId, mode: "code", origin: "https://example.com" }),
    ]);
    expect(await listAgentSiteApprovals(host, "code", otherThreadId)).toEqual([]);
    expect(await listAgentSiteApprovals(host, "chat", threadId)).toEqual([]);
    expect(host.seen.filter((request) => request.path === "/api/pending-requests")).toHaveLength(2);
  });

  it("prompts for a Work site ask and sends the allow the person typed", async () => {
    const host = workHost();
    const approval = await onlyAsk(host, "work");
    const stdout = sink();
    const outcome = await askSiteApproval({
      session: host,
      approval,
      json: false,
      readLine: lines("y"),
      stdout,
      stderr: sink(),
    });
    expect(outcome).toEqual({ kind: "answered", decision: "approved" });
    expect(stdout.text()).toContain("Browser wants to open https://example.com");
    expect(stdout.text()).toContain("[a]lways this site");
    expect(host.seen.at(-1)?.body).toEqual({ kind: "decide", approvalId, decision: "approved" });
  });

  it("remembers the site only when the person answers always", async () => {
    const host = workHost();
    const approval = await onlyAsk(host, "work");
    await askSiteApproval({
      session: host,
      approval,
      json: false,
      readLine: lines("a"),
      stdout: sink(),
      stderr: sink(),
    });
    expect(host.seen.at(-1)?.body).toEqual({
      kind: "decide",
      approvalId,
      decision: "approved",
      remember: true,
    });
  });

  it("sends a deny through the Code answer command the app's Code view uses", async () => {
    const host = codeHost();
    const approval = await onlyAsk(host, "code");
    const stdout = sink();
    const outcome = await askSiteApproval({
      session: host,
      approval,
      json: false,
      readLine: lines("n"),
      stdout,
      stderr: sink(),
    });
    expect(outcome).toEqual({ kind: "answered", decision: "denied" });
    // A Code site ask has no always-allow choice.
    expect(stdout.text()).toContain("Browser wants to open https://example.com");
    expect(stdout.text()).not.toContain("[a]lways");
    expect(host.seen.at(-1)).toMatchObject({
      path: "/api/code/commands",
      method: "POST",
      body: {
        kind: "answer-provider-approval",
        threadId,
        checkoutId,
        approvalId,
        decision: "denied",
      },
    });
  });

  it("refuses with a named reason when nothing can answer, instead of leaving the turn waiting", async () => {
    const host = workHost();
    const approval = await onlyAsk(host, "work");
    const stdout = sink();
    const stderr = sink();
    const outcome = await askSiteApproval({
      session: host,
      approval,
      json: true,
      readLine: lines(),
      stdout,
      stderr,
    });
    expect(outcome).toEqual({ kind: "answered", decision: "denied" });
    expect(JSON.parse(stdout.text().trim())).toMatchObject({
      kind: "site-approval",
      approval: { id: approvalId, mode: "work", origin: "https://example.com" },
    });
    expect(stderr.text()).toContain("No answer came from this terminal");
    expect(host.seen.at(-1)?.body).toEqual({ kind: "decide", approvalId, decision: "denied" });
  });

  it("says why the host refused an answer to an ask that already ended", async () => {
    const host = workHost({ status: 409, body: { accepted: false } });
    const approval = await onlyAsk(host, "work");
    const outcome = await askSiteApproval({
      session: host,
      approval,
      json: false,
      readLine: lines("y"),
      stdout: sink(),
      stderr: sink(),
    });
    expect(outcome).toMatchObject({ kind: "refused" });
  });
});
