import { describe, expect, it } from "vitest";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import {
  resolveProviderSignInCliCommand,
  runProviderSignInCliCommand,
} from "./providerSignInCommand";

const ID = "00000000-0000-4000-8000-000000000912";
const ATTEMPT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = Date.parse("2026-10-26T10:00:00.000Z");
const WARNING =
  "Enter this code only because you just ran this command on this computer. Never enter a sign-in code someone sent you.";

const awaitingCode: LocalControlResponse = {
  status: 200,
  body: {
    outcome: "awaiting-code",
    instanceId: ID,
    displayName: "Contoso Foundry",
    attemptId: ATTEMPT,
    verificationUri: "https://microsoft.com/devicelogin",
    userCode: "F7QK2M9XZ",
    expiresAt: "2026-10-26T10:15:00.000Z",
    warning: WARNING,
  },
};

function fixture(
  respond: (request: LocalControlRequest, index: number) => LocalControlResponse,
  /** null: no terminal can answer. */
  ask: ((question: string) => Promise<string | undefined>) | null = async () => "y",
) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  let clock = NOW;
  return {
    sent,
    out: () => out.join(""),
    err: () => err.join(""),
    questions,
    run: () =>
      runProviderSignInCliCommand({
        command: { instance: "Contoso Foundry" },
        session: {
          kind: "opened",
          windowId: "33333333-3333-4333-8333-333333333333",
          send: async (request) => {
            sent.push(request);
            return respond(request, sent.length - 1);
          },
          close: async () => undefined,
        },
        ask:
          ask === null
            ? undefined
            : async (question) => {
                questions.push(question);
                return ask(question);
              },
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pollIntervalMs: 2_000,
      }),
  };
}

describe("octant provider sign-in", () => {
  it("parses only `sign-in <instance>`, with no flags", () => {
    expect(resolveProviderSignInCliCommand(["sign-in", "Contoso Foundry"], {})).toEqual({
      instance: "Contoso Foundry",
    });
    expect(resolveProviderSignInCliCommand(["sign-in"], {})).toBeUndefined();
    expect(resolveProviderSignInCliCommand(["sign-in", "a", "b"], {})).toBeUndefined();
    expect(resolveProviderSignInCliCommand(["sign-in", "a"], { code: "x" })).toBeUndefined();
  });

  it("shows the directory's page and code, waits for the person, and names the account signed in", async () => {
    const scene = fixture((request, index) => {
      if (request.path.endsWith("/begin")) return awaitingCode;
      return index < 3
        ? {
            status: 200,
            body: { outcome: "waiting", instanceId: ID, displayName: "Contoso Foundry" },
          }
        : {
            status: 200,
            body: {
              outcome: "signed-in",
              instanceId: ID,
              displayName: "Contoso Foundry",
              accountLabel: "ada@contoso.example",
            },
          };
    });

    expect(await scene.run()).toBe(0);

    expect(scene.sent[0]).toEqual({
      path: "/api/desktop/provider-sign-in/begin",
      method: "POST",
      body: { instance: "Contoso Foundry", acknowledgeTerms: false },
    });
    expect(scene.sent.slice(1).map((request) => request.body)).toEqual([
      { instance: "Contoso Foundry", attemptId: ATTEMPT },
      { instance: "Contoso Foundry", attemptId: ATTEMPT },
      { instance: "Contoso Foundry", attemptId: ATTEMPT },
    ]);
    expect(scene.out()).toContain("open https://microsoft.com/devicelogin");
    expect(scene.out()).toContain("Enter the code F7QK2M9XZ");
    expect(scene.out()).toContain(WARNING);
    expect(scene.out()).toContain("about 15 minutes");
    expect(scene.out()).toContain(`Contoso Foundry (${ID}) is signed in as ada@contoso.example.`);
    expect(scene.err()).toBe("");
  });

  it("asks before accepting the sign-in terms, and starts nothing when the person says no", async () => {
    const terms = {
      status: 200,
      body: {
        outcome: "terms-required",
        instanceId: ID,
        displayName: "Contoso Foundry",
        termsSummary: "Octant signs you in with your organization's account.",
      },
    };
    const declined = fixture(
      () => terms,
      async () => "n",
    );

    expect(await declined.run()).toBe(1);
    expect(declined.out()).toContain("Octant signs you in with your organization's account.");
    expect(declined.questions).toEqual(["Continue? [y/N] "]);
    expect(declined.sent).toHaveLength(1);
    expect(declined.err()).toContain("Nothing was started.");

    const accepted = fixture((request, index) =>
      index === 0
        ? terms
        : request.path.endsWith("/begin")
          ? awaitingCode
          : {
              status: 200,
              body: { outcome: "signed-in", instanceId: ID, accountLabel: "ada@contoso.example" },
            },
    );
    expect(await accepted.run()).toBe(0);
    expect(accepted.sent[1]?.body).toEqual({ instance: "Contoso Foundry", acknowledgeTerms: true });

    const noTerminal = fixture(() => terms, null);
    expect(await noTerminal.run()).toBe(1);
    expect(noTerminal.sent).toHaveLength(1);
    expect(noTerminal.err()).toContain("run this command in a terminal");
  });

  it.each([
    [
      "an endpoint that has not opted in",
      { category: "device-code-not-enabled" },
      "Allow sign-in with a code from this host's terminal",
    ],
    [
      "an endpoint without an organization sign-in",
      { category: "no-organization-sign-in" },
      "does not sign in with an organization account",
    ],
    [
      "an unknown endpoint",
      { category: "not-found" },
      'No provider has the id or name "Contoso Foundry".',
    ],
  ])("explains the host's refusal of %s", async (_, body, sentence) => {
    const scene = fixture(() => ({ status: 409, body }));

    expect(await scene.run()).toBe(1);
    expect(scene.err()).toContain(sentence);
    expect(scene.sent).toHaveLength(1);
  });

  it.each([
    ["denied", "The sign-in was declined, so nothing was saved."],
    ["timeout", "The code ran out before the sign-in finished"],
    ["exchange-refused", "must allow public client flows"],
  ])("says how a sign-in that ended as %s ended", async (reason, sentence) => {
    const scene = fixture((request) =>
      request.path.endsWith("/begin")
        ? awaitingCode
        : { status: 409, body: { category: "sign-in-refused", reason } },
    );

    expect(await scene.run()).toBe(1);
    expect(scene.err()).toContain(sentence);
  });

  it("refuses to print a code or page that is not plain", async () => {
    const scene = fixture(() => ({
      status: 200,
      body: { ...(awaitingCode.body as object), userCode: "\u001b[2JABC" },
    }));

    expect(await scene.run()).toBe(1);
    expect(scene.out()).toBe("");
    expect(scene.err()).toContain("unusable answer");
  });

  it("stops waiting once the code has run out", async () => {
    const scene = fixture((request) =>
      request.path.endsWith("/begin")
        ? awaitingCode
        : { status: 200, body: { outcome: "waiting", instanceId: ID } },
    );

    expect(await scene.run()).toBe(1);
    expect(scene.err()).toContain("The code ran out before the sign-in finished");
  });
});
