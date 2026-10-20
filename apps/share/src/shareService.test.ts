import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES } from "@octant/contracts/canvas-public-share";
import { readShareConfig, type ShareConfig } from "./config.ts";
import { startShareService, type ShareService } from "./server.ts";
import { takeDown } from "./takedown.ts";

const DAY_MS = 86_400_000;
const START = Date.parse("2026-10-21T00:00:00.000Z");

let service: ShareService | undefined;
let dataDir = "";
let now = START;

afterEach(() => {
  service?.stop();
  service = undefined;
  if (dataDir !== "") rmSync(dataDir, { recursive: true, force: true });
  dataDir = "";
  now = START;
});

function start(overrides: Partial<ShareConfig> = {}): ShareService {
  dataDir = mkdtempSync(join(tmpdir(), "octant-share-"));
  const config: ShareConfig = {
    host: "127.0.0.1",
    port: 0,
    usercontentPort: 0,
    publicOrigin: undefined,
    usercontentOrigin: undefined,
    dataDir,
    maxDocumentBytes: CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES,
    maxTotalBytes: 1_000_000_000,
    abuseContact: undefined,
    trustProxy: false,
    ...overrides,
  };
  service = startShareService(config, { clock: () => now });
  return service;
}

const heading = { blockId: "intro", schemaVersion: 1, kind: "heading", level: 1, text: "Intro" };
const prose = (text: string) => ({
  blockId: "prose",
  schemaVersion: 1,
  kind: "rich-text",
  text,
});
const design = (extra: Record<string, unknown> = {}) => ({
  blockId: "landing",
  schemaVersion: 1,
  kind: "design",
  title: "Landing",
  size: "desktop",
  frames: [{ frameId: "home", title: "Home", html: "<h1>Hello</h1>" }],
  ...extra,
});

function documentWith(blocks: ReadonlyArray<unknown>, title = "Quarterly plan") {
  return {
    schemaVersion: 1,
    kind: "canvas-public-share-document",
    shareSchemaVersion: 10,
    title,
    summary: "A short summary of the plan",
    publishedAt: "2026-10-21T00:00:00.000Z",
    blocks,
  };
}

function createBody(blocks: ReadonlyArray<unknown> = [heading, prose("Hello there")], extra = {}) {
  return {
    schemaVersion: 1,
    kind: "canvas-public-share-create",
    document: documentWith(blocks),
    expiry: { kind: "days", days: 30 },
    ...extra,
  };
}

interface Created {
  readonly shareId: string;
  readonly url: string;
  readonly ownerSecret: string;
  readonly expiresAt: string | null;
}

async function create(body: unknown = createBody()): Promise<Created> {
  const response = await fetch(`${service?.publicUrl}/api/v1/shares`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

const owner = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe("share service", () => {
  test("mints a 22-character URL-safe id from 16 bytes and a 43-character owner secret", async () => {
    start();
    const created = await create();
    expect(created.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(created.shareId, "base64url")).toHaveLength(16);
    expect(created.ownerSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.url).toBe(`${service?.publicUrl}/s/${created.shareId}`);
    expect(created.expiresAt).toBe(new Date(START + 30 * DAY_MS).toISOString());
  });

  test("stores only a hash of the owner secret", async () => {
    start();
    const created = await create(createBody(undefined, { password: "correct horse" }));
    const stored = readFileSync(join(dataDir, "shares", `${created.shareId}.json`), "utf8");
    expect(stored).not.toContain(created.ownerSecret);
    expect(stored).not.toContain("correct horse");
    expect(statSync(join(dataDir, "shares", `${created.shareId}.json`)).mode & 0o777).toBe(0o600);
  });

  test("updates a link in place under the same id and url and bumps what it shows", async () => {
    start();
    const created = await create();
    const update = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "PUT",
      headers: owner(created.ownerSecret),
      body: JSON.stringify({
        schemaVersion: 1,
        kind: "canvas-public-share-update",
        document: documentWith([heading], "Renamed plan"),
        expiry: { kind: "never" },
      }),
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { url: string; expiresAt: string | null };
    expect(updated.url).toBe(created.url);
    expect(updated.expiresAt).toBeNull();
    const page = await (await fetch(created.url)).text();
    expect(page).toContain("Renamed plan");
    const status = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      headers: owner(created.ownerSecret),
    });
    const body = (await status.json()) as { viewCount: number; kind: string };
    expect(body.kind).toBe("canvas-public-share-status");
    expect(body.viewCount).toBe(1);
  });

  test("answers 403 to a wrong owner secret and to an id that does not exist alike", async () => {
    start();
    const created = await create();
    const wrong = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      headers: owner("x".repeat(43)),
    });
    const unknown = await fetch(`${service?.publicUrl}/api/v1/shares/${"A".repeat(22)}`, {
      headers: owner(created.ownerSecret),
    });
    const missing = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`);
    expect(wrong.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  test("answers 410 on the viewer and the owner routes once a link is revoked", async () => {
    start();
    const created = await create();
    const revoked = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "DELETE",
      headers: owner(created.ownerSecret),
    });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()) as { kind: string }).toMatchObject({
      kind: "canvas-public-share-revoked",
    });
    expect((await fetch(created.url)).status).toBe(410);
    const status = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      headers: owner(created.ownerSecret),
    });
    expect(status.status).toBe(410);
    expect(existsSync(join(dataDir, "shares", `${created.shareId}.json`))).toBe(false);
  });

  test("answers 410 for an expired link and sweeps its payload into a tombstone", async () => {
    start();
    const created = await create();
    now = START + 31 * DAY_MS;
    expect((await fetch(created.url)).status).toBe(410);
    expect(existsSync(join(dataDir, "shares", `${created.shareId}.json`))).toBe(false);
    const tombstone = JSON.parse(
      readFileSync(join(dataDir, "tombstones", `${created.shareId}.json`), "utf8"),
    ) as { reason: string };
    expect(tombstone.reason).toBe("expired");
  });

  test("answers 404 once a tombstone is older than 90 days", async () => {
    start();
    const created = await create();
    await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "DELETE",
      headers: owner(created.ownerSecret),
    });
    now = START + 89 * DAY_MS;
    expect((await fetch(created.url)).status).toBe(410);
    now = START + 91 * DAY_MS;
    expect((await fetch(created.url)).status).toBe(404);
  });

  test("asks a protected link for its password without showing the title and then grants a cookie", async () => {
    start();
    const created = await create(createBody(undefined, { password: "correct horse" }));
    const locked = await fetch(created.url);
    const lockedPage = await locked.text();
    expect(locked.status).toBe(401);
    expect(lockedPage).toContain("Password-protected Canvas");
    expect(lockedPage).not.toContain("Quarterly plan");
    expect(lockedPage).not.toContain("A short summary");

    const form = (password: string) =>
      fetch(created.url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password }),
      });
    expect((await form("wrong password")).status).toBe(401);

    const accepted = await form("correct horse");
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(`/s/${created.shareId}`);
    expect(accepted.headers.get("location")).not.toContain("correct");
    const cookie = accepted.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Path=/s/${created.shareId}`);
    expect(cookie).not.toContain("correct");

    const viewed = await fetch(created.url, { headers: { cookie: cookie.split(";")[0] ?? "" } });
    expect(viewed.status).toBe(200);
    expect(await viewed.text()).toContain("Quarterly plan");
  });

  test("voids a view grant when the link is updated", async () => {
    start();
    const created = await create(createBody(undefined, { password: "correct horse" }));
    const accepted = await fetch(created.url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "correct horse" }),
    });
    const cookie = (accepted.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "PUT",
      headers: owner(created.ownerSecret),
      body: JSON.stringify({
        schemaVersion: 1,
        kind: "canvas-public-share-update",
        document: documentWith([heading]),
        expiry: { kind: "days", days: 5 },
      }),
    });
    expect((await fetch(created.url, { headers: { cookie } })).status).toBe(401);
  });

  test("limits password attempts per link", async () => {
    start();
    const created = await create(createBody(undefined, { password: "correct horse" }));
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await fetch(created.url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: `wrong guess ${String(attempt)}` }),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  test("sends the privacy headers and the exact policy on every viewer page and no script", async () => {
    start();
    const created = await create();
    for (const response of [
      await fetch(created.url),
      await fetch(`${service?.publicUrl}/static/viewer.css`),
      await fetch(`${service?.publicUrl}/s/${"B".repeat(22)}`),
    ]) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toBe(
        "camera=(), microphone=(), geolocation=()",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("strict-transport-security")).toBeNull();
      expect(response.headers.get("content-security-policy")).toBe(
        `default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-src ${service?.usercontentUrl}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      );
    }
    const page = await (await fetch(created.url)).text();
    expect(page.toLowerCase()).not.toContain("<script");
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain('<meta property="og:title" content="Quarterly plan">');
    expect(page).toContain('<meta name="twitter:card" content="summary">');
    expect(page).toContain("Shared with Octant");
  });

  test("names the operator's abuse contact on the page when one is configured", async () => {
    start({ abuseContact: "abuse@example.test" });
    const created = await create();
    expect(await (await fetch(created.url)).text()).toContain("abuse@example.test");
  });

  test("escapes author text instead of drawing it as markup", async () => {
    start();
    const hostile = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
    const created = await create(
      createBody([
        { ...heading, text: hostile },
        prose(hostile),
        {
          blockId: "link",
          schemaVersion: 1,
          kind: "link",
          label: hostile,
          href: "https://example.test/a?x=1&y=2",
        },
      ]),
    );
    const page = await (await fetch(created.url)).text();
    expect(page).not.toContain("<script");
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(page).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  test("draws tables, charts, metrics, callouts, code, math, and diagrams as readable HTML", async () => {
    start();
    const created = await create(
      createBody([
        {
          blockId: "t",
          schemaVersion: 1,
          kind: "table",
          columns: [
            { id: "name", label: "Name", type: "text" },
            { id: "share", label: "Share", type: "number", format: "percent" },
          ],
          rows: [["Alpha", 0.25]],
        },
        {
          blockId: "c",
          schemaVersion: 1,
          kind: "chart",
          chartType: "bar",
          series: [{ seriesId: "s", label: "Revenue", points: [{ x: "Q1", y: 1200 }] }],
        },
        {
          blockId: "m",
          schemaVersion: 1,
          kind: "metric",
          label: "Users",
          value: 1234567,
          format: "compact",
        },
        { blockId: "k", schemaVersion: 1, kind: "callout", tone: "warning", text: "Mind the gap" },
        {
          blockId: "code",
          schemaVersion: 1,
          kind: "code-excerpt",
          language: "ts",
          code: "a < b && c",
        },
        { blockId: "math", schemaVersion: 1, kind: "math", layout: "display", source: "x^2 < y" },
        {
          blockId: "d",
          schemaVersion: 1,
          kind: "diagram",
          nodes: [
            { nodeId: "a", label: "Client" },
            { nodeId: "b", label: "Server" },
          ],
          edges: [{ edgeId: "e", source: "a", target: "b", label: "calls" }],
        },
      ]),
    );
    const page = await (await fetch(created.url)).text();
    expect(page).toContain('<th scope="col">Share</th>');
    expect(page).toContain("25%");
    expect(page).toContain("bar chart, shown as data");
    expect(page).toContain("1.23M");
    expect(page).toContain("Mind the gap");
    expect(page).toContain("a &lt; b &amp;&amp; c");
    expect(page).toContain("<code>x^2 &lt; y</code>");
    expect(page).toContain("Client → Server: calls");
  });

  test("draws a static design as an empty-sandbox frame on the user-content origin", async () => {
    start();
    const created = await create(createBody([heading, design()]));
    const page = await (await fetch(created.url)).text();
    const frame = /<iframe[^>]*>/.exec(page)?.[0] ?? "";
    expect(frame).toContain('sandbox=""');
    expect(frame).toContain(`src="${service?.usercontentUrl}/f/${created.shareId}/landing?t=`);
    expect(frame).not.toContain("allow-same-origin");
  });

  test("offers a running prototype only as a link until the viewer asks to run it", async () => {
    start();
    const created = await create(createBody([design({ runsScript: true })]));
    const before = await (await fetch(created.url)).text();
    expect(before).not.toContain("<iframe");
    expect(before).toContain(`/s/${created.shareId}?run=landing#landing`);
    const after = await (await fetch(`${created.url}?run=landing`)).text();
    const frame = /<iframe[^>]*>/.exec(after)?.[0] ?? "";
    expect(frame).toContain('sandbox="allow-scripts"');
    expect(frame).not.toContain("allow-same-origin");
    const other = await (await fetch(`${created.url}?run=nothing`)).text();
    expect(other).not.toContain("<iframe");
  });

  test("serves frames only for a valid token, under the static or running policy", async () => {
    start();
    const created = await create(createBody([design({ runsScript: true })]));
    const staticDesign = await create(createBody([design()]));

    const runningPage = await (await fetch(`${created.url}?run=landing`)).text();
    const runningSrc =
      /src="([^"]+)"/.exec(/<iframe[^>]*>/.exec(runningPage)?.[0] ?? "")?.[1] ?? "";
    const running = await fetch(runningSrc.replace(/&amp;/g, "&"));
    expect(running.status).toBe(200);
    expect(running.headers.get("content-security-policy")).toBe(
      `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${service?.publicUrl}`,
    );
    expect(await running.text()).toContain("<h1>Hello</h1>");

    const staticPage = await (await fetch(staticDesign.url)).text();
    const staticSrc = (
      /src="([^"]+)"/.exec(/<iframe[^>]*>/.exec(staticPage)?.[0] ?? "")?.[1] ?? ""
    ).replace(/&amp;/g, "&");
    const served = await fetch(staticSrc);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toBe(
      `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${service?.publicUrl}`,
    );
    expect(served.headers.get("x-robots-tag")).toContain("noindex");

    const forged = staticSrc.replace(/\.[^.]+$/, ".AAAA");
    expect((await fetch(forged)).status).toBe(403);
    expect((await fetch(staticSrc.split("?")[0] ?? "")).status).toBe(403);

    now += 11 * 60_000;
    expect((await fetch(staticSrc)).status).toBe(403);
  });

  test("signs a static design's frame address for static mode only", async () => {
    start();
    const created = await create(createBody([design()]));
    const page = await (await fetch(created.url)).text();
    expect(page).toContain("?t=static.");
    expect(page).not.toContain("?t=running.");
  });

  test("refuses an oversized body with 413 and an unknown field with 400", async () => {
    start({ maxDocumentBytes: 4_096 });
    const big = await fetch(`${service?.publicUrl}/api/v1/shares`, {
      method: "POST",
      body: JSON.stringify(createBody([prose("x".repeat(40_000))])),
    });
    expect(big.status).toBe(413);
    expect((await big.json()) as { code: string }).toMatchObject({
      kind: "canvas-public-share-refused",
      code: "too-large",
    });
    const unknown = await fetch(`${service?.publicUrl}/api/v1/shares`, {
      method: "POST",
      body: JSON.stringify({ ...createBody(), surprise: true }),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { code: string }).code).toBe("malformed");
    const longExpiry = await fetch(`${service?.publicUrl}/api/v1/shares`, {
      method: "POST",
      body: JSON.stringify({ ...createBody(), expiry: { kind: "days", days: 366 } }),
    });
    expect(longExpiry.status).toBe(400);
  });

  test("answers unavailable to a create past the storage cap", async () => {
    start({ maxTotalBytes: 100 });
    const response = await fetch(`${service?.publicUrl}/api/v1/shares`, {
      method: "POST",
      body: JSON.stringify(createBody()),
    });
    expect(response.status).toBe(503);
  });

  test("answers 429 to creates past the per-minute limit and again after the window", async () => {
    start();
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await fetch(`${service?.publicUrl}/api/v1/shares`, {
        method: "POST",
        body: JSON.stringify(createBody()),
      });
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(10);
    expect(statuses[10]).toBe(429);
    now += 61_000;
    const later = await fetch(`${service?.publicUrl}/api/v1/shares`, {
      method: "POST",
      body: JSON.stringify(createBody()),
    });
    expect(later.status).toBe(201);
  });

  test("stores a report without the reporter's address", async () => {
    start();
    const created = await create();
    const response = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}/reports`, {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        kind: "canvas-public-share-report",
        reason: "spam",
        detail: "looks like spam",
      }),
    });
    expect(response.status).toBe(202);
    const form = await fetch(`${created.url}/report`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ reason: "phishing", detail: "" }),
    });
    expect(form.status).toBe(200);
    const files = readdirSync(join(dataDir, "reports"));
    expect(files).toHaveLength(2);
    for (const file of files) {
      const text = readFileSync(join(dataDir, "reports", file), "utf8");
      expect(text).toContain(created.shareId);
      expect(text).not.toContain("127.0.0.1");
      expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(
        expect.arrayContaining(["createdAt", "reason", "shareId"]),
      );
    }
  });

  test("answers 410 removed after an operator takedown", async () => {
    start();
    const created = await create();
    expect(takeDown(dataDir, created.shareId)).toEqual({ status: "taken-down" });
    const response = await fetch(created.url);
    expect(response.status).toBe(410);
    expect(await response.text()).toContain("This Canvas was removed.");
    expect(takeDown(dataDir, created.shareId)).toEqual({ status: "already-gone" });
    expect(takeDown(dataDir, "C".repeat(22))).toEqual({ status: "not-found" });
  });

  test("answers the health check with ok and nothing else", async () => {
    start();
    const response = await fetch(`${service?.publicUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("generates the frame key once with owner-only permissions", async () => {
    start();
    await create(createBody([design()]));
    const created = await create(createBody([design()]));
    await fetch(created.url);
    const path = join(dataDir, "frame-key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(path, "utf8"), "base64url")).toHaveLength(32);
  });
});

describe("share configuration", () => {
  test("refuses equal public and user-content origins", () => {
    const result = readShareConfig({
      OCTANT_SHARE_DATA_DIR: "/tmp/x",
      OCTANT_SHARE_PUBLIC_ORIGIN: "https://canvas.example.test",
      OCTANT_SHARE_USERCONTENT_ORIGIN: "https://canvas.example.test/",
    });
    expect(result.status).toBe("refused");
  });

  test("refuses an invalid port and a missing data directory", () => {
    expect(
      readShareConfig({ OCTANT_SHARE_DATA_DIR: "/tmp/x", OCTANT_SHARE_PORT: "nope" }).status,
    ).toBe("refused");
    expect(readShareConfig({}).status).toBe("refused");
  });

  test("defaults to loopback listeners and derives matching origins", () => {
    const result = readShareConfig({ OCTANT_SHARE_DATA_DIR: "/tmp/x" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.config.publicOrigin).toBe("http://127.0.0.1:4100");
      expect(result.config.usercontentOrigin).toBe("http://127.0.0.1:4101");
      expect(result.config.maxTotalBytes).toBe(5 * 1024 * 1024 * 1024);
    }
  });
});
