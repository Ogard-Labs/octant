import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ListenerTrustRefused } from "@octant/client-runtime/remote-listener-trust";
import {
  installPairedComputerIpcHandlers,
  PAIRED_COMPUTER_CHANNELS,
  PairedComputerPins,
} from "./pairedComputers";
import {
  PAIRED_COMPUTER_REQUEST_LIMITS,
  requestPairedComputer,
  type PairedComputerAnswer,
} from "./pairedComputerRequests";

const ORIGIN = "https://100.101.102.103:8443";
const OTHER_ORIGIN = "https://100.101.102.104:8443";
const PIN = "sha256-pinned";
const COOKIE = "__Secure-octant-remote-session=abc123_-";

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "octant-paired-requests-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function pinsWith(origins: ReadonlyArray<string> = [ORIGIN]): PairedComputerPins {
  const pins = new PairedComputerPins(join(mkdtempSync(join(directory, "pins-")), "pins.json"));
  for (const origin of origins) pins.record({ origin, displayName: "Studio Mac", pin: PIN });
  return pins;
}

function transport(answer: () => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const sent = vi.fn<typeof globalThis.fetch>(async () => await answer());
  const fetchFor = vi.fn(() => sent);
  return { sent, fetchFor };
}

async function ask(
  request: unknown,
  options: { pins?: PairedComputerPins; answer?: () => Response | Promise<Response> } = {},
) {
  const { sent, fetchFor } = transport(options.answer);
  const answer = await requestPairedComputer({
    request,
    pins: options.pins ?? pinsWith(),
    fetchFor,
  });
  return { answer, sent, fetchFor };
}

const hello = { origin: ORIGIN, method: "GET", path: "/api/remote/hello?clientNonce=abc" };

describe("a window's request to a paired computer", () => {
  it("is sent over the connection held to that computer's pin, with the signed request's headers", async () => {
    const { answer, sent, fetchFor } = await ask({
      origin: ORIGIN,
      method: "POST",
      path: "/api/code/local-servers/commands",
      headers: {
        Cookie: COOKIE,
        "content-type": "application/json",
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "x-octant-device-proof": "proof",
        "x-octant-csrf": "csrf",
        "x-octant-command-id": "command",
      },
      body: '{"command":"list"}',
    });

    expect(fetchFor).toHaveBeenCalledWith(ORIGIN, { current: { kind: "pinned", pin: PIN } });
    expect(sent).toHaveBeenCalledOnce();
    const [url, init] = sent.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/api/code/local-servers/commands`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toMatchObject({ cookie: COOKIE, origin: ORIGIN });
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('{"command":"list"}');
    expect(answer).toMatchObject({ status: "answered", httpStatus: 200 });
  });

  it("goes only to a listed origin, matched exactly", async () => {
    for (const origin of [
      OTHER_ORIGIN,
      "https://100.101.102.103:9443",
      "http://100.101.102.103:8443",
      `${ORIGIN}/`,
      "https://example.com",
      42,
      undefined,
    ]) {
      const { answer, fetchFor } = await ask({ ...hello, origin });
      expect(answer).toEqual({
        status: "refused",
        message: "Octant isn't paired with that computer.",
      });
      expect(fetchFor).not.toHaveBeenCalled();
    }
  });

  it("is refused for a computer forgotten before it was sent, and its answer is dropped when it is forgotten while the request is out", async () => {
    const pins = pinsWith();
    pins.forget(ORIGIN);
    const gone = await ask(hello, { pins });
    expect(gone.fetchFor).not.toHaveBeenCalled();
    expect(gone.answer.status).toBe("refused");

    const live = pinsWith();
    const raced = await ask(hello, {
      pins: live,
      answer: () => {
        live.forget(ORIGIN);
        return Response.json({ secret: "session" });
      },
    });
    expect(raced.answer).toEqual({
      status: "refused",
      message: "Octant isn't paired with that computer.",
    });
  });

  it("refuses a computer re-paired under another key while the request was out", async () => {
    const pins = pinsWith();
    const raced = await ask(hello, {
      pins,
      answer: () => {
        pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: "sha256-replaced" });
        return Response.json({});
      },
    });
    expect(raced.answer.status).toBe("refused");
  });

  it("names no arbitrary URL: only the listed paths and methods get through", async () => {
    const refused = [
      { path: "//example.com/api/remote/hello" },
      { path: "https://example.com/api/remote/hello" },
      { path: "api/remote/hello" },
      { path: "/api/remote/../auth/sign-out" },
      { path: "/api/remote/%2e%2e/x" },
      { path: "/api/remote/" },
      { path: "/api/remote/hello#fragment" },
      { path: "/api/remote\\hello" },
      { path: "/api/remote/hello\r\nHost: evil" },
      { path: "/api/threads" },
      { path: "/api/server-proxy/abc/index.html" },
      { path: "/api/server-proxy/grants/extra" },
      { path: "/api/host/resources/extra" },
      { path: "/" },
      { path: 42 },
      { path: `/api/remote/${"a".repeat(PAIRED_COMPUTER_REQUEST_LIMITS.pathChars)}` },
      { method: "PUT" },
      { method: "DELETE" },
      { method: "CONNECT" },
      { method: "get" },
      { method: undefined },
    ];
    for (const change of refused) {
      const { answer, fetchFor } = await ask({ ...hello, ...change });
      expect(answer.status, JSON.stringify(change)).toBe("refused");
      expect(fetchFor).not.toHaveBeenCalled();
    }
    for (const path of [
      "/api/remote/hello?clientNonce=abc",
      "/api/remote/auth/session",
      "/api/remote/pairing/status",
      "/api/server-proxy/grants",
      "/api/host/resources",
      "/api/code/local-servers/commands",
    ]) {
      const { answer } = await ask({ ...hello, method: "POST", path, body: "{}" });
      expect(answer.status, path).toBe("answered");
    }
  });

  it("refuses a header a signed request does not carry, a foreign cookie, and a body on GET", async () => {
    const refused = [
      { headers: { host: "example.com" } },
      { headers: { authorization: "Bearer x" } },
      { headers: { "x-octant-window-capability": "capability" } },
      { headers: { cookie: "__Host-other=1" } },
      { headers: { cookie: `${COOKIE}; other=1` } },
      { headers: { origin: "https://example.com" } },
      { headers: { "sec-fetch-site": "cross-site" } },
      { headers: { "x-octant-csrf": "a\r\nb" } },
      { headers: { accept: 42 } },
      { headers: ["cookie", COOKIE] },
      { body: "text" },
      { method: "POST", body: { json: true } },
      { method: "POST", body: "x".repeat(PAIRED_COMPUTER_REQUEST_LIMITS.requestBodyBytes + 1) },
    ];
    for (const change of refused) {
      const { answer, fetchFor } = await ask({ ...hello, ...change });
      expect(answer.status, JSON.stringify(change)).toBe("refused");
      expect(fetchFor).not.toHaveBeenCalled();
    }
  });

  it("returns a redirect as it is and follows none", async () => {
    const { answer, sent } = await ask(hello, {
      answer: () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/steal" } }),
    });

    expect(sent).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({ status: "answered", httpStatus: 302 });
  });

  it("strips cookies and anything that reads like a credential from the reply", async () => {
    const reply = new Response('{"sessionId":"s"}', {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "__Secure-octant-remote-session=abc; HttpOnly"],
        ["set-cookie", "other=1"],
        ["x-octant-device-key", "private"],
        ["x-api-token", "t"],
        ["authorization", "x"],
        ["x-octant-content-digest", "sha256:abc"],
      ],
    });
    const { answer } = await ask(hello, { answer: () => reply });

    if (answer.status !== "answered") throw new Error("expected an answer");
    const names = answer.headers.map(([name]) => name.toLowerCase());
    expect(names).toContain("content-type");
    expect(names).toContain("x-octant-content-digest");
    expect(names.filter((name) => /cookie|key|token|authorization/.test(name))).toEqual([]);
    expect(new TextDecoder().decode(answer.body)).toBe('{"sessionId":"s"}');
  });

  it("carries no key material to the window: the request has none and the answer is data only", async () => {
    const { answer } = await ask(hello);

    expect(Object.keys(answer).sort()).toEqual(["body", "headers", "httpStatus", "status"]);
    const unlisted = requestPairedComputer({
      request: { ...hello, origin: OTHER_ORIGIN },
      pins: pinsWith(),
    });
    await expect(unlisted).resolves.toEqual({
      status: "refused",
      message: "Octant isn't paired with that computer.",
    });
  });

  it("says why the computer could not be trusted or reached, and sends nothing more", async () => {
    const mismatch = await ask(hello, {
      answer: () => {
        throw new ListenerTrustRefused("pin-mismatch");
      },
    });
    expect(mismatch.answer).toMatchObject({ status: "unreachable" });
    expect((mismatch.answer as { message: string }).message).toContain(
      "isn't the computer you paired with",
    );

    const down = await ask(hello, {
      answer: () => {
        throw new TypeError("The listener could not be reached.");
      },
    });
    expect(down.answer).toEqual({
      status: "unreachable",
      message: "Octant couldn't reach that computer.",
    });
  });

  it("fails a reply larger than the limit instead of buffering it", async () => {
    const big = new Response(new Uint8Array(PAIRED_COMPUTER_REQUEST_LIMITS.responseBodyBytes + 1));
    const { answer } = await ask(hello, { answer: () => big });
    expect(answer.status).toBe("unreachable");

    const declared = new Response("small", { headers: { "content-length": "99999999999" } });
    const second = await ask(hello, { answer: () => declared });
    expect(second.answer.status).toBe("unreachable");
  });
});

describe("the request channel", () => {
  it("answers a trusted local window on its own channel and no other window", async () => {
    const handlers = new Map<string, (event: unknown, ...args: readonly unknown[]) => unknown>();
    const { sent, fetchFor } = transport();
    let trusted = false;
    installPairedComputerIpcHandlers({
      handle: (channel, handler) => handlers.set(channel, handler),
      resolveOwnedWindow: () => {
        if (!trusted) throw new Error("not an Octant window");
      },
      pins: () => pinsWith(),
      webBuildVersion: "0.1.0",
      fetchFor,
    });
    const handler = handlers.get(PAIRED_COMPUTER_CHANNELS.request);

    await expect(Promise.resolve().then(() => handler?.({}, hello))).rejects.toThrow(
      "Octant rejected an unauthorized paired-computer request.",
    );
    expect(sent).not.toHaveBeenCalled();
    trusted = true;
    const answer = (await handler?.({}, hello)) as PairedComputerAnswer;
    expect(answer.status).toBe("answered");
  });
});
