import { describe, expect, it } from "vitest";
import { SHAREHTML_API_BASE_URL, createSharehtmlPort } from "./sharehtmlPort";

function fakeFetch(status: number, body: unknown, fail = false) {
  const calls: { input: string; init: Record<string, unknown> }[] = [];
  const fetchPage = (
    input: string,
    init: {
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
      readonly signal: AbortSignal;
    },
  ): Promise<Response> => {
    calls.push({ input, init });
    if (fail) return Promise.reject(new Error("network down"));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { calls, fetchPage };
}

describe("sharehtml port", () => {
  it("posts the page as text/html and reads the created page", async () => {
    const { calls, fetchPage } = fakeFetch(201, {
      id: "abc",
      url: "https://k3x9q2a.sharehtml.org/",
      manageUrl: "https://sharehtml.org/m/key",
    });
    const port = createSharehtmlPort(fetchPage);
    const outcome = await port.createPage("<h1>Hi</h1>");
    expect(calls[0]?.input).toBe(`${SHAREHTML_API_BASE_URL}/pages`);
    expect(outcome).toEqual({
      kind: "created",
      id: "abc",
      url: "https://k3x9q2a.sharehtml.org/",
      manageUrl: "https://sharehtml.org/m/key",
    });
  });

  it("maps a page rejection to refused with the service's message", async () => {
    const { fetchPage } = fakeFetch(422, {
      error: { code: "rejected", message: "abuse heuristics" },
    });
    const outcome = await createSharehtmlPort(fetchPage).createPage("<h1>Hi</h1>");
    expect(outcome).toEqual({ kind: "refused", message: "abuse heuristics" });
  });

  it("maps rate limiting to unavailable with a retry hint", async () => {
    const { fetchPage } = fakeFetch(429, { error: { code: "rate_limited", message: "slow down" } });
    const outcome = await createSharehtmlPort(fetchPage).createPage("<h1>Hi</h1>");
    expect(outcome).toEqual({ kind: "unavailable", message: "slow down Try again later." });
  });

  it("maps a network failure to unavailable", async () => {
    const { fetchPage } = fakeFetch(0, {}, true);
    const outcome = await createSharehtmlPort(fetchPage).createPage("<h1>Hi</h1>");
    expect(outcome).toEqual({
      kind: "unavailable",
      message: "sharehtml.org could not be reached.",
    });
  });

  it("maps a 201 with an unreadable body to unavailable", async () => {
    const { fetchPage } = fakeFetch(201, { nope: true });
    const outcome = await createSharehtmlPort(fetchPage).createPage("<h1>Hi</h1>");
    expect(outcome.kind).toBe("unavailable");
  });
});
