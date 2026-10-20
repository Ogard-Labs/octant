import { afterEach, describe, expect, it, vi } from "vitest";
import { readUriBytes } from "./imageBytes";

afterEach(() => vi.unstubAllGlobals());

describe("read uri bytes", () => {
  it("reports an unreadable file instead of returning an error page as bytes", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));

    expect(await readUriBytes("file:///gone.png")).toEqual({ status: "unreadable" });
  });

  it("returns the bytes of a readable file", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3])));

    expect(await readUriBytes("file:///a.png")).toEqual({
      status: "ok",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });
});
