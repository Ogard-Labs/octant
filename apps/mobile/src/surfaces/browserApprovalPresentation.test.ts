import type { BrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import { describe, expect, it } from "vitest";
import { browserApprovalNote, browserApprovalView } from "./browserApprovalPresentation";

const base = {
  approvalId: "00000000-0000-4000-8000-000000000030",
  threadId: "00000000-0000-4000-8000-000000000020",
  mode: "work",
  origin: "https://example.com",
  requestedAt: "2026-11-25T10:00:00.000Z",
} as const;
const approval = (extra: Record<string, unknown>) => ({ ...base, ...extra }) as BrowserToolApproval;
const labels = (view: ReturnType<typeof browserApprovalView>) => view.answers.map((a) => a.label);

describe("the phone's Browser approval", () => {
  it("names the files, the site and the direction of an upload, and offers Always allow only to the host's person", () => {
    const upload = approval({ upload: { files: [{ name: "report.pdf", sizeBytes: 12_288 }] } });
    const person = browserApprovalView(upload, { actsAsHostPerson: true });
    expect(person).toMatchObject({
      kind: "upload",
      direction: "upload",
      site: "https://example.com",
      profile: "Private",
      files: ["report.pdf (12 KB)"],
      summary: "Let the agent upload report.pdf (12 KB) to https://example.com?",
    });
    expect(labels(person)).toEqual(["Upload once", "Always allow", "Deny"]);
    expect(person.answers[1]?.decision).toEqual({ decision: "approved", remember: true });
    expect(labels(browserApprovalView(upload, { actsAsHostPerson: false }))).toEqual([
      "Upload once",
      "Deny",
    ]);
  });

  it("names a download's file and offers Save once", () => {
    const view = browserApprovalView(
      approval({ download: { name: "data.csv", sizeBytes: 2048, mediaType: "text/csv" } }),
      { actsAsHostPerson: true },
    );
    expect(view).toMatchObject({
      kind: "download",
      direction: "download",
      files: ["data.csv (2 KB)"],
    });
    expect(labels(view)).toEqual(["Save once", "Always allow", "Deny"]);
  });

  it("names the profile of a signed-in site and offers the whole profile only for it", () => {
    const signedIn = approval({ profile: { kind: "personal" } });
    const view = browserApprovalView(signedIn, { actsAsHostPerson: true });
    expect(view.profile).toBe("Personal");
    expect(view.summary).toBe("Let the agent use https://example.com in the Personal profile?");
    expect(labels(view)).toEqual([
      "Approve once",
      "Always allow",
      "Allow all sites in this profile",
      "Deny",
    ]);
    expect(view.answers[2]?.decision).toEqual({ decision: "approved", rememberProfile: true });
    expect(labels(browserApprovalView(approval({}), { actsAsHostPerson: true }))).toEqual([
      "Approve once",
      "Always allow",
      "Deny",
    ]);
  });

  it("never offers to remember a sign-in, a script or a page's tool, and shows the agent's reason", () => {
    const signIn = browserApprovalView(
      approval({ signIn: { reason: "Log in to the vendor portal" } }),
      { actsAsHostPerson: true },
    );
    expect(signIn).toMatchObject({ kind: "sign-in", reason: "Log in to the vendor portal" });
    expect(labels(signIn)).toEqual(["Continue", "Cancel"]);
    const script = browserApprovalView(approval({ script: { source: "document.title" } }), {
      actsAsHostPerson: true,
    });
    expect(script).toMatchObject({ kind: "script", context: "document.title" });
    expect(labels(script)).toEqual(["Run once", "Cancel"]);
    const tool = browserApprovalView(
      approval({ pageTool: { name: "fill_form", arguments: '{"a":1}' } }),
      { actsAsHostPerson: true },
    );
    expect(labels(tool)).toEqual(["Call once", "Cancel"]);
  });

  it("says plainly when another client settled it first or the host refused", () => {
    const view = { kind: "upload", site: "https://example.com" } as const;
    expect(browserApprovalNote("accepted", view)).toBeUndefined();
    expect(browserApprovalNote("settled-elsewhere", view)).toBe(
      "The agent's upload to https://example.com had already been answered or ended, so nothing was sent.",
    );
    expect(browserApprovalNote("refused", view)).toBe(
      "The host refused that answer. Nothing was changed.",
    );
  });

  it("offers a script or arguments the card cannot show in full only Cancel", () => {
    const whole = browserApprovalView(approval({ script: { source: "a".repeat(8192) } }), {
      actsAsHostPerson: true,
    });
    expect(labels(whole)).toEqual(["Run once", "Cancel"]);
    const tooLong = browserApprovalView(approval({ script: { source: "a".repeat(8193) } }), {
      actsAsHostPerson: true,
    });
    expect(labels(tooLong)).toEqual(["Cancel"]);
    const args = browserApprovalView(
      approval({ pageTool: { name: "fill", arguments: "x".repeat(5000) } }),
      { actsAsHostPerson: true },
    );
    expect(labels(args)).toEqual(["Cancel"]);
  });

  it("treats a Private site ask in a Code thread as a program in a terminal, and nothing else as one", () => {
    const terminal = browserApprovalView(approval({ mode: "code" }), {
      actsAsHostPerson: true,
      threadTitle: "Fix the login page",
    });
    expect(terminal).toMatchObject({
      kind: "terminal",
      label: "Browser request from a terminal",
      summary: "Let the terminal open https://example.com in the Browser?",
      detail:
        "Asked by a program in a terminal of “Fix the login page”, not by this thread's agent",
    });
    expect(labels(terminal)).toEqual(["Approve once", "Always allow", "Deny"]);
    expect(
      labels(browserApprovalView(approval({ mode: "code" }), { actsAsHostPerson: false })),
    ).toEqual(["Approve once", "Deny"]);
    expect(
      browserApprovalView(approval({ mode: "code", profile: { kind: "personal" } }), {
        actsAsHostPerson: true,
      }).kind,
    ).toBe("site");
    expect(browserApprovalView(approval({ mode: "work" }), { actsAsHostPerson: true }).kind).toBe(
      "site",
    );
  });
});
