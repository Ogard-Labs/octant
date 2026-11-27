import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ListenerTrustRefused,
  ListenerUnreachable,
} from "@octant/client-runtime/remote-listener-trust";
import { MAX_WORK_ATTACHMENT_BYTES, decodeRelayAddress } from "@octant/contracts";
import { MAX_CODE_ATTACHMENT_BYTES } from "@octant/contracts/code";
import {
  installPairedComputerIpcHandlers,
  PAIRED_COMPUTER_CHANNELS,
  PairedComputerPins,
} from "./pairedComputers";
import {
  PAIRED_COMPUTER_ALLOWED_REQUESTS,
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

  it("passes the selected computer's desktop frame back as image bytes", async () => {
    const body = new Uint8Array([137, 80, 78, 71]);
    const { answer, sent } = await ask(
      { origin: ORIGIN, method: "POST", path: "/api/code/desktops/frame", body: "{}" },
      { answer: () => new Response(body, { headers: { "content-type": "image/png" } }) },
    );
    expect(sent.mock.calls[0]?.[0]).toBe(ORIGIN + "/api/code/desktops/frame");
    expect(answer).toMatchObject({ status: "answered", body });
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

  it("carries attachment metadata only on an attachment route", async () => {
    const headers = {
      "content-type": "image/png",
      "x-octant-code-thread-id": "11111111-1111-4111-8111-111111111111",
      "x-octant-code-attachment-id": "22222222-2222-4222-8222-222222222222",
      "x-octant-code-display-name": "image.png",
    };
    const upload = await ask({
      ...hello,
      method: "PUT",
      path: "/api/code/attachments",
      headers,
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.answer.status).toBe("answered");
    expect(upload.sent).toHaveBeenCalledWith(
      expect.stringContaining("/api/code/attachments"),
      expect.objectContaining({ method: "PUT", headers: expect.objectContaining(headers) }),
    );
    const other = await ask({ ...hello, path: "/api/projects/bootstrap", headers });
    expect(other.answer.status).toBe("refused");
    expect(other.sent).not.toHaveBeenCalled();
  });

  it("returns complete thread event frames and cancels the buffered batch", async () => {
    const cancelled = vi.fn();
    const path = "/api/chat/threads/11111111-1111-4111-8111-111111111111/events?afterSequence=0";
    const { answer } = await ask(
      { ...hello, path },
      {
        answer: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"sequence":1}\n{"sequence":'));
              },
              cancel: cancelled,
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          ),
      },
    );
    expect(answer.status).toBe("answered");
    if (answer.status !== "answered") return;
    expect(new TextDecoder().decode(answer.body)).toBe('{"sequence":1}\n');
    expect(cancelled).toHaveBeenCalled();
    expect(
      (await ask({ ...hello, path: path.replace("11111111-1111-4111-8111-111111111111", "bad") }))
        .answer.status,
    ).toBe("refused");
    expect((await ask({ ...hello, path, method: "POST" })).answer.status).toBe("refused");
  });

  it("supports video playback through the paired host with a single byte range", async () => {
    const clip = { ...hello, path: `/api/video/clip?ticket=${"a".repeat(43)}` };
    const request = await ask(
      { ...clip, headers: { range: "bytes=0-" } },
      {
        answer: () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 206,
            headers: { "content-range": "bytes 0-2/3" },
          }),
      },
    );
    expect(request.sent.mock.calls[0]?.[1]?.headers).toMatchObject({ range: "bytes=0-" });
    expect(request.answer).toMatchObject({ status: "answered", httpStatus: 206 });

    for (const refused of [
      clip,
      { ...clip, headers: { range: "bytes=0-2,4-6" } },
      { ...hello, headers: { range: "bytes=0-" } },
      { ...clip, method: "POST", headers: { range: "bytes=0-" } },
      {
        ...hello,
        method: "POST",
        path: "/api/video/jobs/a1b2c3d4-0000-4000-8000-000000000001/stop",
      },
    ]) {
      const result = await ask(refused);
      expect(result.answer.status).toBe("refused");
      expect(result.sent).not.toHaveBeenCalled();
    }
  });

  it("names no arbitrary URL: only the listed paths and methods get through", async () => {
    const refused = [
      { path: "//example.com/api/remote/hello" },
      { path: "https://example.com/api/remote/hello" },
      { path: "api/remote/hello" },
      { path: "/api/remote/../auth/sign-out" },
      { path: "/api/remote/%2e%2e/x" },
      { path: "/api/remote/" },
      { path: "/api/remote/auth/push-token", method: "POST" },
      { path: "/api/remote/hello/extra" },
      { path: "/api/remote/auth/session" },
      { path: "/api/remote/hello", method: "POST" },
      { path: "/api/code/local-servers/other", method: "POST" },
      { path: "/api/remote/auth/device", method: "POST" },
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
    for (const { method, path, requiredQuery, hubMemberOnly } of PAIRED_COMPUTER_ALLOWED_REQUESTS) {
      if (hubMemberOnly === true) continue;
      const filled = path.replaceAll(":id", "a1b2c3d4-0000-4000-8000-000000000001");
      const query = new URLSearchParams(requiredQuery).toString();
      const { answer } = await ask({
        ...hello,
        method,
        path:
          path === "/api/remote/hello"
            ? `${path}?clientNonce=abc`
            : query === ""
              ? filled
              : `${filled}?${query}`,
        ...(method === "GET" ? {} : { body: "{}" }),
        ...(method === "GET" && path === "/api/video/clip"
          ? { headers: { range: "bytes=0-" } }
          : {}),
      });
      expect(answer.status, `${method} ${path}`).toBe("answered");
    }
    expect(PAIRED_COMPUTER_ALLOWED_REQUESTS.map(({ method, path }) => `${method} ${path}`)).toEqual(
      [
        "GET /api/remote/hello",
        "POST /api/remote/pairing",
        "POST /api/remote/pairing/status",
        "POST /api/remote/negotiate",
        "POST /api/remote/auth/challenge",
        "POST /api/remote/auth/session",
        "POST /api/remote/auth/server-proxy-session",
        "GET /api/remote/auth/device",
        "GET /api/remote/relay-address",
        "POST /api/remote/auth/sign-out",
        "POST /api/remote/auth/rotate-key",
        "POST /api/remote/auth/revoke-self",
        "POST /api/server-proxy/grants",
        "POST /api/server-proxy/forwards",
        "GET /api/host/resources",
        "POST /api/code/local-servers/commands",
        "POST /api/code/desktops",
        "POST /api/code/desktops/frame",
        "GET /api/todos",
        "GET /api/todos/changes",
        "POST /api/todos/commands",
        "GET /api/chat/bootstrap",
        "GET /api/chat/navigation",
        "GET /api/work/threads/bootstrap",
        "GET /api/work/navigation",
        "GET /api/reply-detail",
        "GET /api/extensions/snapshot",
        "GET /api/conversation-inputs",
        "GET /api/work/requests",
        "GET /api/code/attachments",
        "GET /api/work/attachments",
        "POST /api/chat/commands",
        "POST /api/work/threads/commands",
        "POST /api/work/turns",
        "POST /api/work/turns/cancel",
        "POST /api/work/turns/rewind",
        "POST /api/work/mutations",
        "POST /api/work/requests/commands",
        "POST /api/chat/attachments",
        "PUT /api/code/attachments",
        "PUT /api/work/attachments",
        "DELETE /api/code/attachments",
        "DELETE /api/work/attachments",
        "GET /api/chat/threads/:id",
        "GET /api/chat/threads/:id/window",
        "GET /api/chat/threads/:id/events",
        "GET /api/work/turns/transcript/:id",
        "GET /api/work/turns/window/:id",
        "GET /api/work/turns/stream/:id",
        "GET /api/code/content/:id",
        "GET /api/chat/attachments/:id",
        "DELETE /api/chat/attachments/:id",
        "GET /api/code/bootstrap",
        "GET /api/code/navigation",
        "GET /api/video/jobs",
        "POST /api/video/clip",
        "GET /api/video/clip",
        "GET /api/code/threads/:id",
        "GET /api/code/threads/:id/conversation",
        "GET /api/code/threads/:id/conversation/window",
        "GET /api/code/threads/:id/follow-up",
        "POST /api/code/threads/:id/follow-up",
        "GET /api/code/threads/:id/events",
        "GET /api/code/threads/:id/operations/:id/events",
        "GET /api/code/threads/:id/operations/:id/evidence/:id",
        "POST /api/code/commands",
        "POST /api/code/evidence/batch",
        "PUT /api/code/evidence",
        "GET /api/projects/bootstrap",
        "POST /api/folders/browse",
        "POST /api/folders/select",
        "POST /api/projects/repository-bootstrap/clone",
        "POST /api/projects/repository-bootstrap/clone/status",
        "POST /api/projects/repository-bootstrap/clone/cancel",
        "POST /api/projects/repository-bootstrap/land-files",
        "POST /api/projects/commands",
        "GET /api/providers/bootstrap",
        "GET /api/pending-requests",
        "POST /api/extensions/tool-approvals",
        "POST /api/hub/guest",
      ],
    );
  });

  it("asks a member of this host's hub to admit the window as its guest, and never a computer paired directly", async () => {
    const pins = pinsWith([ORIGIN]);
    pins.replaceHubMembers([
      { origin: OTHER_ORIGIN, displayName: "Mini PC", pin: PIN, hostId: "member-b" },
    ]);
    const admission = (origin: string) => ({
      origin,
      method: "POST",
      path: "/api/hub/guest",
      headers: { "content-type": "application/json", "x-octant-hub-link": "signed" },
      body: "{}",
    });

    const toMember = await ask(admission(OTHER_ORIGIN), { pins });
    const toPaired = await ask(admission(ORIGIN), { pins });

    expect(toMember.answer).toMatchObject({ status: "answered", httpStatus: 200 });
    expect(toMember.fetchFor).toHaveBeenCalledWith(OTHER_ORIGIN, {
      current: { kind: "pinned", pin: PIN },
    });
    expect(toPaired.answer).toEqual({
      status: "refused",
      message: "Octant doesn't send that request to another computer.",
    });
    expect(toPaired.fetchFor).not.toHaveBeenCalled();
    // The hub member is reached like a paired computer for everything else on the list.
    const read = await ask(
      { origin: OTHER_ORIGIN, method: "GET", path: "/api/code/navigation" },
      { pins },
    );
    expect(read.answer.status).toBe("answered");
    // A member the host no longer names is no longer reachable.
    pins.replaceHubMembers([]);
    expect((await ask(admission(OTHER_ORIGIN), { pins })).answer).toEqual({
      status: "refused",
      message: "Octant isn't paired with that computer.",
    });
  });

  it("carries a Code thread's reads and commands to a paired computer", async () => {
    const thread = "a1b2c3d4-0000-4000-8000-000000000001";
    const operation = "a1b2c3d4-0000-4000-8000-000000000002";
    const content = "a1b2c3d4-0000-4000-8000-000000000003";
    for (const request of [
      { method: "GET", path: "/api/code/bootstrap" },
      { method: "GET", path: `/api/code/threads/${thread}` },
      { method: "GET", path: `/api/code/threads/${thread}/conversation/window?limit=1` },
      { method: "GET", path: `/api/code/threads/${thread}/events?afterSequence=4&wait=0` },
      {
        method: "GET",
        path: `/api/code/threads/${thread}/operations/${operation}/events?afterCursor=0`,
      },
      {
        method: "GET",
        path: `/api/code/threads/${thread}/operations/${operation}/evidence/${content}`,
      },
      { method: "POST", path: "/api/code/evidence/batch", body: "{}" },
      { method: "GET", path: "/api/pending-requests" },
      { method: "POST", path: "/api/extensions/tool-approvals", body: "{}" },
      { method: "POST", path: "/api/code/commands", body: "{}" },
    ]) {
      const { answer } = await ask({ origin: ORIGIN, ...request });
      expect(answer.status, `${request.method} ${request.path}`).toBe("answered");
    }
  });

  it("carries Code follow-up reads and commands only for lowercase thread UUIDs", async () => {
    const thread = "a1b2c3d4-0000-4000-8000-000000000001";
    const path = `/api/code/threads/${thread}/follow-up`;
    const read = await ask({ ...hello, path });
    expect(read.answer.status).toBe("answered");
    expect(read.sent).toHaveBeenCalledWith(
      `${ORIGIN}${path}`,
      expect.objectContaining({ method: "GET" }),
    );

    const update = await ask({ ...hello, method: "POST", path, body: "{}" });
    expect(update.answer.status).toBe("answered");
    expect(update.sent).toHaveBeenCalledWith(
      `${ORIGIN}${path}`,
      expect.objectContaining({ method: "POST" }),
    );

    const wrongMethod = await ask({ ...hello, method: "PUT", path });
    expect(wrongMethod.answer.status).toBe("refused");
    expect(wrongMethod.fetchFor).not.toHaveBeenCalled();

    for (const malformedPath of [
      "/api/code/threads/not-a-thread/follow-up",
      `/api/code/threads/${thread.toUpperCase()}/follow-up`,
    ]) {
      const malformed = await ask({ ...hello, path: malformedPath });
      expect(malformed.answer.status, malformedPath).toBe("refused");
      expect(malformed.fetchFor).not.toHaveBeenCalled();
    }
  });

  it("refuses thread events that would wait, and an id segment that is not a UUID", async () => {
    const thread = "a1b2c3d4-0000-4000-8000-000000000001";
    for (const path of [
      // Without wait=0 the host holds the read open past this channel's limit.
      `/api/code/threads/${thread}/events?afterSequence=4`,
      `/api/code/threads/${thread}/events?afterSequence=4&wait=1`,
      "/api/code/threads/not-a-thread",
      `/api/code/threads/${thread.toUpperCase()}`,
      `/api/code/threads/${thread}/extra`,
      "/api/code/threads/../bootstrap",
      `/api/code/threads/${thread}/operations/${thread}/evidence/not-a-content-id`,
    ]) {
      const { answer, fetchFor } = await ask({ origin: ORIGIN, method: "GET", path });
      expect(answer.status, path).toBe("refused");
      expect(fetchFor).not.toHaveBeenCalled();
    }
  });

  it("carries a thread's first prompt with its thread header, and PUT nowhere else", async () => {
    const thread = "a1b2c3d4-0000-4000-8000-000000000001";
    const { answer, sent } = await ask({
      origin: ORIGIN,
      method: "PUT",
      path: "/api/code/evidence",
      headers: { "content-type": "text/plain", "x-octant-code-thread-id": thread },
      body: "Fix the failing test",
    });
    expect(answer.status).toBe("answered");
    expect(sent.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-octant-code-thread-id": thread });

    const elsewhere = await ask({ origin: ORIGIN, method: "PUT", path: "/api/code/commands" });
    expect(elsewhere.answer.status).toBe("refused");
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

  it("allows a bounded 10 MiB only for destination attachment uploads", async () => {
    const destinations = [
      ["POST", "/api/chat/attachments", MAX_CODE_ATTACHMENT_BYTES],
      ["PUT", "/api/code/attachments", MAX_CODE_ATTACHMENT_BYTES],
      ["PUT", "/api/work/attachments", MAX_WORK_ATTACHMENT_BYTES],
    ] as const;
    const overEightMiB = new Uint8Array(8 * 1_024 * 1_024 + 1);
    for (const [method, path, limit] of destinations) {
      const accepted = await ask({ ...hello, method, path, body: overEightMiB });
      expect(accepted.answer.status).toBe("answered");
      expect(accepted.sent).toHaveBeenCalledOnce();

      const boundary = await ask({
        ...hello,
        method,
        path,
        body: new Uint8Array(limit),
      });
      expect(boundary.answer.status).toBe("answered");

      const tooLarge = await ask({
        ...hello,
        method,
        path,
        body: new Uint8Array(limit + 1),
      });
      expect(tooLarge.answer.status).toBe("refused");
      expect(tooLarge.fetchFor).not.toHaveBeenCalled();
    }

    for (const [method, path] of [
      ["POST", "/api/chat/commands"],
      ["GET", "/api/code/attachments"],
      ["DELETE", "/api/code/attachments"],
      ["DELETE", "/api/work/attachments"],
      ["POST", "/api/work/turns"],
    ] as const) {
      const refused = await ask({ ...hello, method, path, body: overEightMiB });
      expect(refused.answer.status).toBe("refused");
      expect(refused.fetchFor).not.toHaveBeenCalled();
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

describe("a pairing that is open for a computer", () => {
  function staged(origins: ReadonlyArray<string> = []) {
    const pins = pinsWith(origins);
    pins.stage({ origin: OTHER_ORIGIN, displayName: "Laptop", pin: "sha256-staged" });
    return pins;
  }

  it("reaches a computer not yet recorded on the pairing routes alone, held to the staged pin", async () => {
    const pins = staged();
    const claim = { origin: OTHER_ORIGIN, method: "POST", path: "/api/remote/pairing", body: "{}" };
    const { answer, fetchFor } = await ask(claim, { pins });
    expect(answer.status).toBe("answered");
    expect(fetchFor).toHaveBeenCalledWith(OTHER_ORIGIN, {
      current: { kind: "pinned", pin: "sha256-staged" },
    });

    for (const route of ["/api/remote/auth/session", "/api/host/resources"]) {
      const refused = await ask(
        { ...claim, path: route, method: route.endsWith("resources") ? "GET" : "POST" },
        { pins },
      );
      expect(refused.answer, route).toEqual({
        status: "refused",
        message: "Octant isn't paired with that computer.",
      });
      expect(refused.fetchFor).not.toHaveBeenCalled();
    }
  });

  it("keeps a computer already paired on its recorded pin for every route, hello included", async () => {
    const pins = pinsWith([OTHER_ORIGIN]);
    pins.stage({ origin: OTHER_ORIGIN, displayName: "Laptop", pin: "sha256-staged" });

    for (const request of [
      { method: "GET", path: "/api/remote/hello?clientNonce=abc" },
      { method: "POST", path: "/api/remote/pairing", body: "{}" },
      { method: "POST", path: "/api/remote/auth/session", body: "{}" },
    ]) {
      const { fetchFor } = await ask({ origin: OTHER_ORIGIN, ...request }, { pins });
      expect(fetchFor, request.path).toHaveBeenCalledWith(OTHER_ORIGIN, {
        current: { kind: "pinned", pin: PIN },
      });
    }
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
      hubAdministration: () => {
        throw new Error("No hub administration in this test.");
      },
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

describe("reaching a paired computer through its hub when away", () => {
  const HOST = "22222222-2222-4222-8222-222222222222";
  const HUB = "11111111-1111-4111-8111-111111111111";
  const RELAY_URL = "wss://hub.example.com/relay/v1";
  const ADMISSION = { signature: "s".repeat(86), deviceSpki: "k".repeat(91) };

  function pinsWithHost(): PairedComputerPins {
    const pins = new PairedComputerPins(join(mkdtempSync(join(directory, "pins-")), "pins.json"));
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: PIN, hostId: HOST });
    return pins;
  }

  function away() {
    const direct = vi.fn<typeof globalThis.fetch>(async () => {
      throw new ListenerUnreachable();
    });
    const relayed = vi.fn<typeof globalThis.fetch>(async () => Response.json({ relayed: true }));
    const routes: Array<{ url: string; targetMemberId: string; hubMemberId?: string }> = [];
    const admitted: string[] = [];
    return {
      direct,
      relayed,
      routes,
      admitted,
      options: (pins: PairedComputerPins) => ({
        pins,
        fetchFor: () => direct,
        admitRelay: async (_origin: string, payload: string) => {
          admitted.push(payload);
          return ADMISSION;
        },
        relayedFetchFor: (
          _origin: string,
          _trust: unknown,
          route: { url: string; targetMemberId: string; hubMemberId?: string },
        ) => {
          routes.push({
            url: route.url,
            targetMemberId: route.targetMemberId,
            ...(route.hubMemberId === undefined ? {} : { hubMemberId: route.hubMemberId }),
          });
          return relayed;
        },
      }),
    };
  }

  it("learns the relay address from the computer's own answer at home", async () => {
    const pins = pinsWithHost();
    const answer = await requestPairedComputer({
      request: { origin: ORIGIN, method: "GET", path: "/api/remote/relay-address" },
      pins,
      fetchFor: () => async () =>
        Response.json({ status: "available", hubMemberId: HUB, relayUrl: RELAY_URL }),
    });
    expect(answer.status).toBe("answered");
    expect(pins.relayFor(ORIGIN)).toEqual({
      enabled: false,
      address: { hubMemberId: HUB, relayUrl: RELAY_URL },
    });
    expect(pins.list()[0]?.relayThroughHub).toEqual({ enabled: false, addressKnown: true });
  });

  it("never relays while this app's choice for that computer is off", async () => {
    const pins = pinsWithHost();
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: RELAY_URL }),
    );
    const scene = away();
    const answer = await requestPairedComputer({ request: hello, ...scene.options(pins) });
    expect(answer.status).toBe("unreachable");
    expect(scene.relayed).not.toHaveBeenCalled();
    expect(scene.admitted).toEqual([]);
  });

  it("relays through the hub the computer named once the choice is on and home is out of reach", async () => {
    const pins = pinsWithHost();
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: RELAY_URL }),
    );
    expect(pins.setRelayChoice(ORIGIN, true)).toBe(true);
    const scene = away();
    const answer = await requestPairedComputer({ request: hello, ...scene.options(pins) });
    expect(answer.status).toBe("answered");
    expect(scene.direct).toHaveBeenCalledTimes(1);
    expect(scene.relayed).toHaveBeenCalledTimes(1);
    expect(scene.routes).toEqual([{ url: RELAY_URL, targetMemberId: HOST, hubMemberId: HUB }]);
  });

  it("keeps no address from an answer that came through the relay, and none from a refusal", async () => {
    const pins = pinsWithHost();
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: RELAY_URL }),
    );
    pins.setRelayChoice(ORIGIN, true);
    const scene = away();
    scene.relayed.mockImplementation(async () =>
      Response.json({ status: "available", hubMemberId: HUB, relayUrl: "wss://other/relay/v1" }),
    );
    await requestPairedComputer({
      request: { origin: ORIGIN, method: "GET", path: "/api/remote/relay-address" },
      ...scene.options(pins),
    });
    expect(pins.relayFor(ORIGIN)?.address?.relayUrl).toBe(RELAY_URL);
  });

  it("never relays a pairing request", async () => {
    const pins = pinsWithHost();
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: RELAY_URL }),
    );
    pins.setRelayChoice(ORIGIN, true);
    const scene = away();
    await requestPairedComputer({
      request: { origin: ORIGIN, method: "POST", path: "/api/remote/pairing", body: "{}" },
      ...scene.options(pins),
    });
    expect(scene.relayed).not.toHaveBeenCalled();
  });

  function relayingPins(): PairedComputerPins {
    const pins = pinsWithHost();
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: RELAY_URL }),
    );
    pins.setRelayChoice(ORIGIN, true);
    return pins;
  }

  it("goes to the relay first for the next request, without dialing home again", async () => {
    const pins = relayingPins();
    const scene = away();
    await requestPairedComputer({ request: hello, ...scene.options(pins) });
    const answer = await requestPairedComputer({ request: hello, ...scene.options(pins) });
    expect(answer.status).toBe("answered");
    expect(scene.direct).toHaveBeenCalledTimes(1);
    expect(scene.relayed).toHaveBeenCalledTimes(2);
  });

  it("dials home first again once the choice, the address, or the pairing changes", async () => {
    const pins = relayingPins();
    const scene = away();
    const send = () => requestPairedComputer({ request: hello, ...scene.options(pins) });
    await send();
    pins.setRelayChoice(ORIGIN, false);
    pins.setRelayChoice(ORIGIN, true);
    await send();
    expect(scene.direct).toHaveBeenCalledTimes(2);
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: "wss://other.example.com/relay/v1" }),
    );
    await send();
    expect(scene.direct).toHaveBeenCalledTimes(3);
    pins.forget(ORIGIN);
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: PIN, hostId: HOST });
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: "wss://other.example.com/relay/v1" }),
    );
    pins.setRelayChoice(ORIGIN, true);
    await send();
    expect(scene.direct).toHaveBeenCalledTimes(4);
  });

  it("learns the address from home's answer after a relay that was preferred failed", async () => {
    const pins = relayingPins();
    const scene = away();
    await requestPairedComputer({ request: hello, ...scene.options(pins) });
    scene.relayed.mockImplementation(async () => {
      throw new ListenerUnreachable();
    });
    scene.direct.mockImplementation(async () => Response.json({ status: "unavailable" }));
    await requestPairedComputer({
      request: { origin: ORIGIN, method: "GET", path: "/api/remote/relay-address" },
      ...scene.options(pins),
    });
    expect(pins.relayFor(ORIGIN)).toEqual({ enabled: true });
  });

  it("keeps the choice and the address across a restart", () => {
    const path = join(mkdtempSync(join(directory, "pins-")), "pins.json");
    const pins = new PairedComputerPins(path);
    pins.record({ origin: ORIGIN, displayName: "Studio Mac", pin: PIN, hostId: HOST });
    pins.rememberRelayAddress(
      ORIGIN,
      decodeRelayAddress({ hubMemberId: HUB, relayUrl: RELAY_URL }),
    );
    pins.setRelayChoice(ORIGIN, true);
    expect(new PairedComputerPins(path).relayFor(ORIGIN)).toEqual({
      enabled: true,
      address: { hubMemberId: HUB, relayUrl: RELAY_URL },
    });
  });
});
