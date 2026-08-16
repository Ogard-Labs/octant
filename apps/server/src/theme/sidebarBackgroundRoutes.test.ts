import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_BACKGROUND, type SidebarBackground } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createSidebarBackgroundRouteHandler } from "./sidebarBackgroundRoutes";
import { SidebarBackgroundStore } from "./backgroundStore";

function makePng(width = 2, height = 2, extra = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdr, crc, Buffer.alloc(extra)]);
}

let dataDir: string;
let store: SidebarBackgroundStore;
let windowAuthorityStore: WindowAuthorityStore;
let capability: string;
let activeBackground: SidebarBackground = DEFAULT_SIDEBAR_BACKGROUND;
let handler: ReturnType<typeof createSidebarBackgroundRouteHandler>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "octant-bg-routes-"));
  store = new SidebarBackgroundStore({ dataDirectory: dataDir });
  windowAuthorityStore = new WindowAuthorityStore();
  capability = randomBytes(32).toString("base64url");
  windowAuthorityStore.register({
    windowId: "00000000-0000-4000-8000-000000000001" as never,
    capability,
    now: 1_000,
  });
  activeBackground = DEFAULT_SIDEBAR_BACKGROUND;
  handler = createSidebarBackgroundRouteHandler({
    store,
    windowAuthorityStore,
    currentSidebarBackground: () => activeBackground,
    now: () => 1_000,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function authedRequest(
  method: string,
  path: string,
  options: {
    readonly body?: Uint8Array | Buffer;
    readonly headers?: Record<string, string>;
  } = {},
): Request {
  const init: RequestInit = {
    method,
    headers: {
      "x-octant-window-capability": capability,
      ...options.headers,
    },
  };
  if (options.body !== undefined) {
    init.body = new Uint8Array(options.body);
  }
  return new Request(`http://127.0.0.1${path}`, init);
}

describe("sidebar background routes", () => {
  it("rejects requests without window capability", async () => {
    const res = await handler(
      new Request("http://127.0.0.1/api/theme/sidebar-backgrounds", { method: "GET" }),
    );
    expect(res?.status).toBe(401);
  });

  it("rejects non-loopback requests", async () => {
    const res = await handler(
      new Request("http://example.com/api/theme/sidebar-backgrounds", {
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(res?.status).toBe(400);
  });

  it("uploads a background and returns metadata", async () => {
    const png = makePng(2, 2, 48);
    const res = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: png,
        headers: {
          "content-type": "image/png",
          "x-octant-sidebar-background-display-name": "test.png",
        },
      }),
    );
    expect(res?.status).toBe(200);
    const json = await res!.json();
    expect(json.id).toBeTruthy();
    expect(json.displayName).toBe("test.png");
    expect(json.mediaType).toBe("image/png");
  });

  it("lists uploaded backgrounds", async () => {
    const png = makePng(2, 2, 48);
    const uploadRes = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: png,
        headers: {
          "content-type": "image/png",
          "x-octant-sidebar-background-display-name": "a.png",
        },
      }),
    );
    const uploaded = await uploadRes!.json();
    const listRes = await handler(authedRequest("GET", "/api/theme/sidebar-backgrounds"));
    expect(listRes?.status).toBe(200);
    const list = await listRes!.json();
    expect(list.backgrounds).toHaveLength(1);
    expect(list.backgrounds[0].id).toBe(uploaded.id);
  });

  it("reads background bytes", async () => {
    const png = makePng(2, 2, 48);
    const uploadRes = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: png,
        headers: {
          "content-type": "image/png",
          "x-octant-sidebar-background-display-name": "r.png",
        },
      }),
    );
    const uploaded = await uploadRes!.json();
    const readRes = await handler(
      authedRequest("GET", `/api/theme/sidebar-backgrounds/${uploaded.id}`),
    );
    expect(readRes?.status).toBe(200);
    expect(readRes?.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await readRes!.arrayBuffer());
    expect(bytes.byteLength).toBe(png.length);
  });

  it("returns metadata for a single background", async () => {
    const png = makePng(2, 2, 48);
    const uploadRes = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: png,
        headers: {
          "content-type": "image/png",
          "x-octant-sidebar-background-display-name": "m.png",
        },
      }),
    );
    const uploaded = await uploadRes!.json();
    const metaRes = await handler(
      authedRequest("GET", `/api/theme/sidebar-backgrounds/${uploaded.id}/metadata`),
    );
    expect(metaRes?.status).toBe(200);
    const meta = await metaRes!.json();
    expect(meta.id).toBe(uploaded.id);
    expect(meta.displayName).toBe("m.png");
  });

  it("deletes a background", async () => {
    const png = makePng(2, 2, 48);
    const uploadRes = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: png,
        headers: {
          "content-type": "image/png",
          "x-octant-sidebar-background-display-name": "d.png",
        },
      }),
    );
    const uploaded = await uploadRes!.json();
    const delRes = await handler(
      authedRequest("DELETE", `/api/theme/sidebar-backgrounds/${uploaded.id}`),
    );
    expect(delRes?.status).toBe(204);
    const listRes = await handler(authedRequest("GET", "/api/theme/sidebar-backgrounds"));
    const list = await listRes!.json();
    expect(list.backgrounds).toHaveLength(0);
  });

  it("rejects deletion of a custom background that is currently in use", async () => {
    const png = makePng(2, 2, 48);
    const uploadRes = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: png,
        headers: {
          "content-type": "image/png",
          "x-octant-sidebar-background-display-name": "active.png",
        },
      }),
    );
    const uploaded = await uploadRes!.json();
    activeBackground = {
      kind: "custom",
      backgroundId: uploaded.id,
      overlayColor: "#1a1a1c",
      overlayOpacity: 80,
      vibrancyMode: "off",
    } as SidebarBackground;
    const delRes = await handler(
      authedRequest("DELETE", `/api/theme/sidebar-backgrounds/${uploaded.id}`),
    );
    expect(delRes?.status).toBe(409);
    const listRes = await handler(authedRequest("GET", "/api/theme/sidebar-backgrounds"));
    const list = await listRes!.json();
    expect(list.backgrounds).toHaveLength(1);
  });

  it("returns 404 for unknown background", async () => {
    const res = await handler(
      authedRequest("GET", "/api/theme/sidebar-backgrounds/00000000-0000-4000-8000-000000000b99"),
    );
    expect(res?.status).toBe(404);
  });

  it("returns undefined for unrelated paths", async () => {
    const res = await handler(authedRequest("GET", "/api/other"));
    expect(res).toBeUndefined();
  });

  it("rejects oversized uploads with 413", async () => {
    const res = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: Buffer.alloc(9_000_000, 0xff),
        headers: {
          "content-type": "image/png",
          "x-octant-sidebar-background-display-name": "big.png",
        },
      }),
    );
    expect(res?.status).toBe(413);
  });

  it("rejects invalid media type with 400", async () => {
    const res = await handler(
      authedRequest("POST", "/api/theme/sidebar-backgrounds", {
        body: Buffer.alloc(64, 0xff),
        headers: {
          "content-type": "image/gif",
          "x-octant-sidebar-background-display-name": "gif.gif",
        },
      }),
    );
    expect(res?.status).toBe(400);
  });
});
