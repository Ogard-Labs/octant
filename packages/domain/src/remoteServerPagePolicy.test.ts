import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  judgeRemoteServerPageRequest,
  remoteServerPageAccessCookie,
  remoteServerPageLabelInput,
  remoteServerPageName,
  remoteServerPageResponseHeaders,
  remoteServerPageUpstreamHeaders,
} from "./remoteServerPagePolicy";

const hostId = "11111111-1111-4111-8111-111111111111";
const threadId = "77777777-7777-4777-8777-777777777777";
const pageOrigin = "http://5173-abcdefghijklmnop.octant.localhost:47610";
const listenerOrigin = "https://192.168.1.20:9443";
const grantPath = `/api/server-proxy/rsg_${"ab".repeat(32)}`;

function nameFor(input: { hostId: string; threadId: string; port: number }): string {
  const digest = createHash("sha256").update(remoteServerPageLabelInput(input)).digest();
  return remoteServerPageName({ port: input.port, digest });
}

describe("a page's name", () => {
  it("stays the same for the same host, thread, and port", () => {
    const name = nameFor({ hostId, threadId, port: 5173 });
    expect(name).toMatch(/^5173-[a-z2-7]{16}\.octant\.localhost$/);
    expect(nameFor({ hostId, threadId, port: 5173 })).toBe(name);
  });

  it("differs for another host, thread, or port", () => {
    const name = nameFor({ hostId, threadId, port: 5173 });
    expect(nameFor({ hostId, threadId, port: 5174 })).not.toBe(name);
    expect(
      nameFor({ hostId: "22222222-2222-4222-8222-222222222222", threadId, port: 5173 }),
    ).not.toBe(name);
    expect(
      nameFor({ hostId, threadId: "88888888-8888-4888-8888-888888888888", port: 5173 }),
    ).not.toBe(name);
  });
});

describe("who reaches a page", () => {
  const judge = (input: Partial<Parameters<typeof judgeRemoteServerPageRequest>[0]>) =>
    judgeRemoteServerPageRequest({
      pageOrigin,
      secFetchSite: undefined,
      origin: undefined,
      accessPresented: true,
      ...input,
    });

  it("admits the page's own requests and the person's own navigation with the secret", () => {
    expect(judge({ secFetchSite: "same-origin", origin: pageOrigin })).toEqual({
      status: "admitted",
    });
    expect(judge({ secFetchSite: "none" })).toEqual({ status: "admitted" });
    expect(judge({})).toEqual({ status: "admitted" });
  });

  it("refuses a request from a sibling octant.localhost name or any other site", () => {
    expect(judge({ secFetchSite: "same-site" })).toEqual({
      status: "refused",
      reason: "cross-site",
    });
    expect(judge({ secFetchSite: "cross-site" })).toEqual({
      status: "refused",
      reason: "cross-site",
    });
    expect(
      judge({
        origin: "http://3000-zzzzzzzzzzzzzzzz.octant.localhost:47610",
        secFetchSite: "none",
      }),
    ).toEqual({ status: "refused", reason: "cross-site" });
  });

  it("refuses a request without the page's secret", () => {
    expect(judge({ accessPresented: false, secFetchSite: "same-origin" })).toEqual({
      status: "refused",
      reason: "no-access",
    });
  });

  it("finds the access cookie among the page's own cookies", () => {
    expect(remoteServerPageAccessCookie("theme=dark; octant-page-access=s3cret; a=b")).toBe(
      "s3cret",
    );
    expect(remoteServerPageAccessCookie("theme=dark")).toBeUndefined();
  });
});

describe("headers the forwarder sends the host", () => {
  const upstream = (headers: ReadonlyArray<readonly [string, string]>) =>
    remoteServerPageUpstreamHeaders({ headers, pageOrigin, listenerOrigin, grantPath });

  it("speaks as the listener's own origin and moves a page Referer under the grant", () => {
    const headers = upstream([
      ["Origin", pageOrigin],
      ["Referer", `${pageOrigin}/settings?tab=1`],
      ["sec-fetch-site", "same-origin"],
    ]);
    expect(headers).toContainEqual(["origin", listenerOrigin]);
    expect(headers).toContainEqual(["referer", `${listenerOrigin}${grantPath}/settings?tab=1`]);
    expect(headers.filter(([name]) => name === "sec-fetch-site")).toEqual([
      ["sec-fetch-site", "same-origin"],
    ]);
  });

  it("never lets the page's secret, its host name, or a hop header leave this computer", () => {
    const headers = upstream([
      ["host", "5173-abcdefghijklmnop.octant.localhost:47610"],
      ["x-octant-page-access", "s3cret"],
      ["cookie", "octant-page-access=s3cret; session=abc"],
      ["connection", "keep-alive"],
      ["content-length", "3"],
      ["accept", "text/html"],
    ]);
    expect(headers).toEqual([
      ["cookie", "session=abc"],
      ["accept", "text/html"],
      ["sec-fetch-site", "same-origin"],
    ]);
  });

  it("drops a Referer from another site", () => {
    expect(upstream([["referer", "https://example.com/"]])).toEqual([
      ["sec-fetch-site", "same-origin"],
    ]);
  });
});

describe("headers the page receives", () => {
  const received = (headers: ReadonlyArray<readonly [string, string]>) =>
    remoteServerPageResponseHeaders({ headers, pageOrigin, upstreamPort: 5173 });

  it("moves a redirect to the dev server's own origin onto the page's name", () => {
    for (const location of [
      "http://localhost:5173/login?next=%2F#top",
      "http://127.0.0.1:5173/login?next=%2F#top",
      "https://[::1]:5173/login?next=%2F#top",
    ]) {
      expect(received([["location", location]])).toEqual([
        ["location", `${pageOrigin}/login?next=%2F#top`],
      ]);
    }
  });

  it("leaves relative and other-origin redirects alone", () => {
    expect(received([["location", "/login"]])).toEqual([["location", "/login"]]);
    expect(received([["location", "http://localhost:3000/"]])).toEqual([
      ["location", "http://localhost:3000/"],
    ]);
    expect(received([["location", "https://accounts.example.com/"]])).toEqual([
      ["location", "https://accounts.example.com/"],
    ]);
  });

  it("makes a loopback cookie host-only on the page and keeps its other attributes", () => {
    expect(
      received([["set-cookie", "sid=1; Domain=.localhost; Path=/app; SameSite=Lax; Secure"]]),
    ).toEqual([["set-cookie", "sid=1; Path=/app; SameSite=Lax; Secure"]]);
    expect(received([["set-cookie", "sid=1; Domain=example.com"]])).toEqual([
      ["set-cookie", "sid=1; Domain=example.com"],
    ]);
  });

  it("drops HSTS, Octant's headers, and a cookie named for Octant", () => {
    expect(
      received([
        ["strict-transport-security", "max-age=63072000"],
        ["x-octant-server-proxy", "relayed"],
        ["set-cookie", "octant-page-access=forged; Path=/"],
        ["content-type", "text/html"],
      ]),
    ).toEqual([["content-type", "text/html"]]);
  });
});
