import { describe, expect, it, vi } from "vitest";
import type { PairedComputerAnswer, PairedComputersBridge } from "../shell/hostBridge";
import { createPairedComputerFetch } from "./pairedComputerFetch";

const ORIGIN = "https://100.101.102.103:8443";

function fetchOver(answer: PairedComputerAnswer) {
  const requestPairedComputer = vi.fn<PairedComputersBridge["requestPairedComputer"]>(
    async () => answer,
  );
  return { fetch: createPairedComputerFetch({ requestPairedComputer }), requestPairedComputer };
}

const ok: PairedComputerAnswer = {
  status: "answered",
  httpStatus: 200,
  headers: [["content-type", "application/json"]],
  body: new TextEncoder().encode('{"ok":true}'),
};

describe("a request to a computer paired through the desktop app", () => {
  it("goes to the desktop as origin and path, with the cookie and origin a signed request carries", async () => {
    const { fetch, requestPairedComputer } = fetchOver(ok);

    const response = await fetch(`${ORIGIN}/api/code/local-servers/commands?x=1`, {
      method: "post",
      headers: {
        cookie: "__Secure-octant-remote-session=abc",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: '{"a":1}',
    });

    expect(requestPairedComputer).toHaveBeenCalledWith({
      origin: ORIGIN,
      method: "POST",
      path: "/api/code/local-servers/commands?x=1",
      headers: {
        cookie: "__Secure-octant-remote-session=abc",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: '{"a":1}',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("fails like a network error when the desktop refuses or cannot reach the computer", async () => {
    for (const status of ["refused", "unreachable"] as const) {
      const { fetch } = fetchOver({ status, message: "Octant isn't paired with that computer." });
      await expect(fetch(`${ORIGIN}/api/remote/hello`)).rejects.toThrow(
        "Octant isn't paired with that computer.",
      );
    }
  });

  it("answers a bodyless status without a body and refuses a body it cannot send exactly", async () => {
    const { fetch } = fetchOver({ ...ok, httpStatus: 204 });
    expect((await fetch(`${ORIGIN}/api/remote/hello`)).status).toBe(204);

    await expect(
      fetch(`${ORIGIN}/api/remote/auth/session`, { method: "POST", body: new FormData() }),
    ).rejects.toThrow(TypeError);
  });

  it("stops waiting when the caller aborts", async () => {
    const pending = new Promise<PairedComputerAnswer>(() => {});
    const fetch = createPairedComputerFetch({ requestPairedComputer: () => pending });
    const controller = new AbortController();

    const request = fetch(`${ORIGIN}/api/remote/hello`, { signal: controller.signal });
    controller.abort(new Error("cancelled"));

    await expect(request).rejects.toThrow("cancelled");
  });
});
