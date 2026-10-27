import { describe, expect, it } from "vitest";
import { decodeDesktopCredentialRef } from "@octant/contracts";
import { createDesktopHttpsPort, type DesktopHttpsFetch } from "./desktopHttpsPort";

const recorded = decodeDesktopCredentialRef("e3000000-0000-4000-8000-000000000001");
const another = decodeDesktopCredentialRef("e3000000-0000-4000-8000-000000000002");
const hosts = ["api.cloud.example", "*.sandbox.cloud.example"];

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly redirect: RequestRedirect | undefined;
}

function harness(
  answer: (url: string) => Response | Promise<Response> = () => new Response("{}"),
  options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {},
) {
  const seen: Array<Seen> = [];
  const read: Array<string> = [];
  const fetch: DesktopHttpsFetch = async (url, init) => {
    seen.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
    const signal = init.signal;
    return Promise.race([
      Promise.resolve(answer(url)),
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
  };
  const port = createDesktopHttpsPort({
    hosts: () => hosts,
    credentialPermitted: (ref) => String(ref) === String(recorded),
    credential: async (ref) => {
      read.push(String(ref));
      return "the-person's-key";
    },
    fetch,
    ...options,
  });
  return { port, seen, read };
}

const call = (url: string) => ({ method: "GET" as const, url, maxResponseBytes: 1_024 });

describe("desktop HTTPS port", () => {
  it.each([
    "http://api.cloud.example/v1",
    "https://api.cloud.example:8443/v1",
    "https://user:secret@api.cloud.example/v1",
    "https://elsewhere.example/v1",
    "https://cloud.example/v1",
    "https://127.0.0.1/v1",
  ])("refuses %s before reading any credential", async (url) => {
    const { port, seen, read } = harness();
    await expect(
      port.request({
        ...call(url),
        credential: { ref: recorded, header: "X-API-Key" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "host-not-declared" });
    expect(seen).toEqual([]);
    expect(read).toEqual([]);
  });

  it("attaches the key only for a credential one of the provider's leases recorded", async () => {
    const { port, seen, read } = harness();
    await expect(
      port.request({
        ...call("https://api.cloud.example/v1/vms"),
        credential: { ref: another, header: "X-API-Key" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "credential-not-permitted" });
    expect(read).toEqual([]);

    await expect(
      port.request({
        ...call("https://api.cloud.example/v1/vms"),
        credential: { ref: recorded, header: "Authorization", scheme: "Bearer" },
      }),
    ).resolves.toMatchObject({ status: "answered", httpStatus: 200 });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer the-person's-key");
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("sends no key on a call that names no credential", async () => {
    const { port, seen, read } = harness();
    await port.request({
      ...call("https://vm-1.sandbox.cloud.example/screen"),
      headers: { "X-Access-Token": "desktop-token" },
    });
    expect(read).toEqual([]);
    expect(seen[0]?.headers.get("x-access-token")).toBe("desktop-token");
    expect([...(seen[0]?.headers.keys() ?? [])]).toEqual(["x-access-token"]);
  });

  it("refuses headers the host owns", async () => {
    const { port, seen } = harness();
    await expect(
      port.request({ ...call("https://api.cloud.example/v1"), headers: { Host: "elsewhere" } }),
    ).resolves.toEqual({ status: "refused", reason: "request-invalid" });
    await expect(
      port.request({
        ...call("https://api.cloud.example/v1"),
        credential: { ref: recorded, header: "Cookie" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "request-invalid" });
    expect(seen).toEqual([]);
  });

  it("refuses a redirect rather than follow it", async () => {
    const { port, seen } = harness(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }),
    );
    await expect(port.request(call("https://api.cloud.example/v1"))).resolves.toEqual({
      status: "failed",
      reason: "redirected",
    });
    expect(seen).toHaveLength(1);
  });

  it("stops reading a response past the bound the call named", async () => {
    const { port } = harness(() => new Response(new Uint8Array(2_048)));
    await expect(port.request(call("https://api.cloud.example/v1"))).resolves.toEqual({
      status: "failed",
      reason: "response-too-large",
    });
    const capped = harness(() => new Response(new Uint8Array(512)), { maxResponseBytes: 256 });
    await expect(capped.port.request(call("https://api.cloud.example/v1"))).resolves.toEqual({
      status: "failed",
      reason: "response-too-large",
    });
  });

  it("answers a provider that never replies as timed out, and a cancelled call as cancelled", async () => {
    const silent = harness(() => new Promise<Response>(() => undefined), { timeoutMs: 20 });
    await expect(silent.port.request(call("https://api.cloud.example/v1"))).resolves.toEqual({
      status: "failed",
      reason: "timed-out",
    });
    const controller = new AbortController();
    const pending = silent.port.request({
      ...call("https://api.cloud.example/v1"),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  it("answers an error status with its body, for the driver to read", async () => {
    const { port } = harness(() =>
      Response.json({ code: 404, message: "not found" }, { status: 404 }),
    );
    const answered = await port.request(call("https://api.cloud.example/v1/vms/x"));
    expect(answered).toMatchObject({ status: "answered", httpStatus: 404 });
    if (answered.status === "answered") {
      expect(JSON.parse(new TextDecoder().decode(answered.body))).toEqual({
        code: 404,
        message: "not found",
      });
    }
  });
});
