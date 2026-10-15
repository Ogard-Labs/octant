import { describe, expect, it } from "vitest";
import {
  isOctantCookieName,
  relayRequestHeaders,
  relayResponseHeaders,
  type RemoteServerRelayHeader,
} from "./remoteServerProxyRelayPolicy";

const listenerOrigin = "https://192.168.1.20:9443";
const grantPath = `/api/server-proxy/rsg_${"ab".repeat(32)}`;

function relayed(
  headers: ReadonlyArray<RemoteServerRelayHeader>,
  overrides: Partial<Parameters<typeof relayRequestHeaders>[0]> = {},
) {
  return relayRequestHeaders({
    headers,
    listenerOrigin,
    grantPath,
    upstream: { scheme: "http", port: 5173 },
    bodyBytes: undefined,
    ...overrides,
  });
}

describe("headers relayed to a dev server", () => {
  it("names the dev server as localhost at its port and asks it to close", () => {
    const headers = relayed([["host", "192.168.1.20:9443"]]);
    expect(headers).toContainEqual(["host", "localhost:5173"]);
    expect(headers.filter(([name]) => name === "host")).toHaveLength(1);
    expect(headers).toContainEqual(["connection", "close"]);
  });

  it("never sends Octant's credentials, fetch metadata, or a forwarding claim", () => {
    const headers = relayed([
      ["X-Octant-Device-Proof", "proof"],
      ["x-octant-csrf", "csrf"],
      ["x-octant-command-id", "id"],
      ["sec-fetch-site", "same-origin"],
      ["forwarded", "for=10.0.0.1"],
      ["x-forwarded-for", "10.0.0.1"],
      ["x-real-ip", "10.0.0.1"],
      ["proxy-authorization", "Basic abc"],
      ["accept", "text/html"],
    ]);
    expect(headers.map(([name]) => name).sort()).toEqual(["accept", "connection", "host"]);
  });

  it("removes Octant's cookies and keeps the page's own", () => {
    const headers = relayed([
      [
        "cookie",
        "__Secure-octant-server-proxy-session=s1; app_session=abc; __Host-Octant-claim=x; theme=dark",
      ],
    ]);
    expect(headers).toContainEqual(["cookie", "app_session=abc; theme=dark"]);
    expect(
      relayed([["cookie", "__Secure-octant-remote-session=s2"]]).map(([name]) => name),
    ).not.toContain("cookie");
  });

  it("drops hop-by-hop headers and every header Connection names", () => {
    const headers = relayed([
      ["connection", "keep-alive, X-Dev-Hop"],
      ["keep-alive", "timeout=5"],
      ["x-dev-hop", "1"],
      ["te", "trailers"],
      ["upgrade", "websocket"],
      ["transfer-encoding", "chunked"],
      ["content-length", "999"],
    ]);
    expect(headers).toEqual([
      ["host", "localhost:5173"],
      ["connection", "close"],
    ]);
  });

  it("states the body length the host sends, not the one the request claimed", () => {
    expect(relayed([["content-length", "999"]], { bodyBytes: 12 })).toContainEqual([
      "content-length",
      "12",
    ]);
  });

  it("presents the listener's Origin as the dev server's own and drops any other", () => {
    expect(relayed([["origin", listenerOrigin]])).toContainEqual([
      "origin",
      "http://localhost:5173",
    ]);
    expect(
      relayed([["origin", listenerOrigin]], { upstream: { scheme: "https", port: 8443 } }),
    ).toContainEqual(["origin", "https://localhost:8443"]);
    expect(relayed([["origin", "https://evil.example"]]).map(([name]) => name)).not.toContain(
      "origin",
    );
  });

  it("maps a Referer under the grant's path to the dev server and drops any other", () => {
    expect(relayed([["referer", `${listenerOrigin}${grantPath}/docs/page?q=1`]])).toContainEqual([
      "referer",
      "http://localhost:5173/docs/page?q=1",
    ]);
    expect(relayed([["referer", `${listenerOrigin}${grantPath}`]])).toContainEqual([
      "referer",
      "http://localhost:5173/",
    ]);
    for (const other of [
      `${listenerOrigin}/api/server-proxy/rsg_${"cd".repeat(32)}/page`,
      `${listenerOrigin}${grantPath}x/page`,
      "https://evil.example/page",
      "not a url",
    ]) {
      expect(relayed([["referer", other]]).map(([name]) => name)).not.toContain("referer");
    }
  });

  it("passes the page's own end-to-end headers unchanged", () => {
    const headers = relayed([
      ["accept", "text/html"],
      ["authorization", "Bearer dev-token"],
      ["content-type", "multipart/form-data; boundary=x"],
    ]);
    expect(headers).toContainEqual(["authorization", "Bearer dev-token"]);
    expect(headers).toContainEqual(["content-type", "multipart/form-data; boundary=x"]);
  });
});

describe("headers relayed back from a dev server", () => {
  it("drops hop-by-hop headers, the length, origin directives, and anything posing as Octant's", () => {
    const headers = relayResponseHeaders([
      ["Connection", "keep-alive, X-Hop"],
      ["x-hop", "1"],
      ["keep-alive", "timeout=5"],
      ["transfer-encoding", "chunked"],
      ["content-length", "42"],
      ["proxy-authenticate", "Basic"],
      ["x-octant-server-proxy", "relayed"],
      ["clear-site-data", '"*"'],
      ["Alt-Svc", 'h3=":443"'],
      ["content-type", "text/html"],
      ["location", "http://evil.example/"],
    ]);
    expect(headers).toEqual([
      ["content-type", "text/html"],
      ["location", "http://evil.example/"],
    ]);
  });

  it("drops a Set-Cookie for Octant's cookies and keeps the page's own", () => {
    const headers = relayResponseHeaders([
      ["set-cookie", "__Secure-octant-server-proxy-session=forged; Path=/"],
      ["set-cookie", "octant-claim=forged"],
      ["set-cookie", "app_session=abc; Path=/; HttpOnly"],
    ]);
    expect(headers).toEqual([["set-cookie", "app_session=abc; Path=/; HttpOnly"]]);
  });
});

describe("Octant's cookie names", () => {
  it("covers every prefix form and case and nothing else", () => {
    for (const name of [
      "octant-claim",
      "Octant-Claim",
      "__Secure-octant-remote-session",
      "__host-OCTANT-x",
      " octant-padded ",
    ]) {
      expect(isOctantCookieName(name)).toBe(true);
    }
    for (const name of ["octantish", "app-octant-x", "__Secure-app", "session"]) {
      expect(isOctantCookieName(name)).toBe(false);
    }
  });
});
