import {
  CANVAS_NETWORK_PROXY_PATH_PREFIX,
  CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX,
} from "@octant/contracts/canvas-network";
import { describe, expect, it } from "vitest";
import { CANVAS_PROTOTYPE_SCHEME } from "./canvasPrototypeHost";
import { canvasNetworkRelayAddress, canvasPrototypeRelayRequest } from "./canvasPrototypeNetwork";

const surfaceId = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const token = "t".repeat(43);
const server = "http://127.0.0.1:3773";
const relay = `${CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX}${surfaceId}/fetch`;
const target = "https://api.example.com/data?page=2&sort=asc#top";
const asked = `${relay}?url=${encodeURIComponent(target)}`;
const networked = (id: string) => id === surfaceId;

const decide = (url: string, method = "GET") =>
  canvasPrototypeRelayRequest({ url, method }, networked);

describe("what a prototype page may ask the desktop to fetch", () => {
  it("relays a GET of its own surface's relay address, with the address it asked for", () => {
    expect(decide(asked)).toEqual({ status: "relay", surfaceId, target });
  });

  it("is the address the host writes into the page, under the prototype host's scheme", () => {
    expect(CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX).toBe(`${CANVAS_PROTOTYPE_SCHEME}://network/`);
  });

  it("refuses every other scheme, loopback and the host's own proxy path among them", () => {
    for (const url of [
      `http://127.0.0.1:3773${CANVAS_NETWORK_PROXY_PATH_PREFIX}${token}/fetch?url=${encodeURIComponent(target)}`,
      `http://localhost:3773/api/shell`,
      `https://network/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `ws://network/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `file:///etc/passwd`,
      `octant://network/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `data:text/plain,x`,
      "not an address",
      "",
    ]) {
      expect(decide(url)).toEqual({ status: "refused", reason: "not-the-relay" });
    }
  });

  it("refuses every other host of its scheme, and one dressed with a port or credentials", () => {
    for (const url of [
      `${CANVAS_PROTOTYPE_SCHEME}://page/${surfaceId}`,
      `${CANVAS_PROTOTYPE_SCHEME}://page/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `${CANVAS_PROTOTYPE_SCHEME}://127.0.0.1/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `${CANVAS_PROTOTYPE_SCHEME}://network.example/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `${CANVAS_PROTOTYPE_SCHEME}://network:3773/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `${CANVAS_PROTOTYPE_SCHEME}://user:pass@network/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
      `${CANVAS_PROTOTYPE_SCHEME}://NETWORK/${surfaceId}/fetch?url=${encodeURIComponent(target)}`,
    ]) {
      expect(decide(url)).toEqual({ status: "refused", reason: "not-the-relay" });
    }
  });

  it("refuses every other path, however it is spelled", () => {
    for (const path of [
      "",
      `${surfaceId}`,
      `${surfaceId}/`,
      `${surfaceId}/fetch/`,
      `${surfaceId}/fetch/more`,
      `${surfaceId}/other`,
      `${surfaceId}/../${surfaceId}/fetch`,
      `${surfaceId}//fetch`,
      `${surfaceId}/%66etch`,
      `x/${surfaceId}/fetch`,
      "ABCDEF12-1111-4111-8111-111111111111/fetch",
      "not-a-surface/fetch",
      `api/canvas/network/${token}/fetch`,
    ]) {
      expect(
        decide(`${CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX}${path}?url=${encodeURIComponent(target)}`),
      ).toEqual({ status: "refused", reason: "not-the-relay" });
    }
  });

  it("refuses a surface that was given no network, another page's among them", () => {
    expect(
      decide(
        `${CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX}${other}/fetch?url=${encodeURIComponent(target)}`,
      ),
    ).toEqual({ status: "refused", reason: "no-network" });
    expect(canvasPrototypeRelayRequest({ url: asked, method: "GET" }, () => false)).toEqual({
      status: "refused",
      reason: "no-network",
    });
  });

  it("refuses every method but GET", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "get", ""]) {
      expect(decide(asked, method)).toEqual({ status: "refused", reason: "method-not-allowed" });
    }
  });

  it("refuses any query but one address to fetch", () => {
    for (const query of [
      "",
      "?",
      "?url=",
      "?other=https%3A%2F%2Fexample.com%2F",
      `?url=${encodeURIComponent(target)}&url=https%3A%2F%2Fexample.com%2F`,
      `?url=${encodeURIComponent(target)}&token=${token}`,
      `?url=${"a".repeat(9_000)}`,
    ]) {
      expect(decide(`${relay}${query}`)).toEqual({ status: "refused", reason: "invalid-request" });
    }
    expect(decide(`${asked}#fragment`)).toEqual({ status: "refused", reason: "not-the-relay" });
  });

  it("does not judge the address asked for: loopback goes to the host, whose rule refuses it", () => {
    expect(decide(`${relay}?url=${encodeURIComponent("http://127.0.0.1:3773/api/shell")}`)).toEqual(
      { status: "relay", surfaceId, target: "http://127.0.0.1:3773/api/shell" },
    );
  });
});

describe("where the desktop sends a page's request", () => {
  it("is the host's proxy path under the surface's token, with the address as one query value", () => {
    expect(canvasNetworkRelayAddress(server, token, target)).toBe(
      `${server}${CANVAS_NETWORK_PROXY_PATH_PREFIX}${token}/fetch?url=${encodeURIComponent(target)}`,
    );
  });

  it("cannot be moved off that path or that host by the address a page chose", () => {
    for (const hostile of [
      "/../../../shell",
      "../../../../api/shell",
      "https://example.com/&url=http://127.0.0.1/",
      "x#/api/shell",
      "x?y=1",
      "\\\\evil.example\\share",
      "@evil.example/",
      "http://127.0.0.1:3773/api/shell",
      "%2e%2e%2f%2e%2e%2fshell",
      "a\r\nHost: evil.example",
    ]) {
      const address = canvasNetworkRelayAddress(server, token, hostile);
      if (address === undefined) throw new Error("expected an address");
      const url = new URL(address);
      expect(url.origin).toBe(server);
      expect(url.pathname).toBe(`${CANVAS_NETWORK_PROXY_PATH_PREFIX}${token}/fetch`);
      expect([...url.searchParams.keys()]).toEqual(["url"]);
      expect(url.searchParams.get("url")).toBe(hostile);
      expect(url.hash).toBe("");
      expect(url.username).toBe("");
    }
  });

  it("is nowhere without a token the host could have minted or a loopback host to ask", () => {
    for (const bad of [
      "",
      "short",
      `${token}/`,
      `../${"t".repeat(40)}`,
      `${token}x`,
      "t".repeat(42),
    ]) {
      expect(canvasNetworkRelayAddress(server, bad, target)).toBeUndefined();
    }
    for (const elsewhere of [
      undefined,
      "",
      "not an address",
      "https://octant.example",
      "http://localhost:3773",
      "http://192.168.1.10:3773",
      "http://user@127.0.0.1:3773",
      "file:///tmp/x",
    ]) {
      expect(canvasNetworkRelayAddress(elsewhere, token, target)).toBeUndefined();
    }
  });
});
