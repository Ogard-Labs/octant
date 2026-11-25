import { createHash } from "node:crypto";
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";

// Password and owner-secret hashing is intentionally slow, and the password
// tests pay several of those hashes each; slow CI runners pass bun's 5 s
// default test timeout because of that, not because anything is wrong.
setDefaultTimeout(30_000);
import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES,
  CANVAS_SHARE_SCHEMA_VERSION,
  decodeCanvasPublicShareDocument,
} from "./shareKit.ts";
import { readShareConfig, type ShareConfig } from "./config.ts";
import { startShareService, type ShareService } from "./server.ts";
import { renderDesignFramePage } from "./frames.ts";
import { ShareStore } from "./store.ts";
import { runTakedown } from "./takedown.ts";

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
    operatorPort: 0,
    operatorToken: undefined,
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
    shareSchemaVersion: CANVAS_SHARE_SCHEMA_VERSION,
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

const OPERATOR_TOKEN = "t".repeat(40);
/** What the operator's shell holds to reach the running service's operator listener. */
function operatorEnv(): Record<string, string> {
  const port = new URL(service?.operatorUrl ?? "http://127.0.0.1:0").port;
  return { OCTANT_SHARE_OPERATOR_TOKEN: OPERATOR_TOKEN, OCTANT_SHARE_OPERATOR_PORT: port };
}

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

  test("shows a choice as its options with no control to answer it", async () => {
    start();
    const created = await create(
      createBody([
        {
          blockId: "pick",
          schemaVersion: 27,
          kind: "choice",
          prompt: "Which rollout?",
          questions: [
            {
              id: "rollout",
              prompt: "Rollout",
              selection: "single",
              options: [
                { id: "staged", label: "Staged", description: "Ten percent a day" },
                { id: "all", label: "<b>All</b> at once" },
              ],
            },
          ],
        },
      ]),
    );
    const page = await (await fetch(created.url)).text();
    expect(page).toContain("Which rollout?");
    expect(page).toContain("<strong>Staged</strong> Ten percent a day");
    expect(page).toContain("&lt;b&gt;All&lt;/b&gt; at once");
    expect(page).toContain("Answers are sent from the Canvas in Octant, not from this page.");
    // The page's own report form sits in the footer; the choice offers none.
    const block = page.slice(page.indexOf('<section class="block block-choice"'));
    expect(block.slice(0, block.indexOf("</section>"))).not.toMatch(
      /<(form|button|input|textarea)\b/i,
    );
  });

  test("shows a decision form's sections above their questions, still with no control", async () => {
    start();
    const created = await create(
      createBody([
        {
          blockId: "decisions",
          schemaVersion: 29,
          kind: "choice",
          prompt: "Decisions",
          questions: [
            {
              id: "who",
              prompt: "Who may set it?",
              selection: "single",
              options: [{ id: "any", label: "Any device" }],
            },
          ],
          sections: [
            { id: "access", title: "Full access", intro: "Who and how far", questionIds: ["who"] },
          ],
        },
      ]),
    );
    const page = await (await fetch(created.url)).text();
    const block = page.slice(page.indexOf('<section class="block block-choice"'));
    const html = block.slice(0, block.indexOf("</section>"));
    expect(html.indexOf("Full access")).toBeLessThan(html.indexOf("Who may set it?"));
    expect(html).toContain("Who and how far");
    expect(html).not.toMatch(/<(form|button|input|textarea)\b/i);
  });

  test("durably cancels its exact owned id before a slow create completes and refuses replay", async () => {
    start();
    const ownerSecret = "k".repeat(43);
    const shareId = createHash("sha256")
      .update("octant-canvas-public-share-id-v1\0" + ownerSecret)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
    const body = {
      ...createBody(undefined, { password: "fixture-password" }),
      kind: "canvas-public-share-owned-create",
      shareId,
      ownerSecret,
    };
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hashing = spyOn(Bun.password, "hash").mockImplementation(async () => {
      enter();
      await gate;
      return "fixture-hash";
    });
    let creating: Promise<Response> | undefined;
    try {
      creating = fetch(`${service?.publicUrl}/api/v1/shares`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await entered;
      const wrong = await fetch(`${service?.publicUrl}/api/v1/shares/${shareId}`, {
        method: "DELETE",
        headers: owner("z".repeat(43)),
      });
      expect(wrong.status).toBe(403);
      expect(readdirSync(join(dataDir, "tombstones"))).toHaveLength(0);
      const unrelated = await fetch(`${service?.publicUrl}/api/v1/shares/${"Z".repeat(22)}`, {
        method: "DELETE",
        headers: owner(ownerSecret),
      });
      expect(unrelated.status).toBe(403);
      expect(readdirSync(join(dataDir, "tombstones"))).toHaveLength(0);
      const cancelled = await fetch(`${service?.publicUrl}/api/v1/shares/${shareId}`, {
        method: "DELETE",
        headers: owner(ownerSecret),
      });
      release();
      const created = await creating;
      const viewed = await fetch(`${service?.publicUrl}/s/${shareId}`);
      expect({
        cancelled: cancelled.status,
        created: created.status,
        viewed: viewed.status,
      }).toEqual({ cancelled: 200, created: 410, viewed: 410 });
      const persisted = readFileSync(join(dataDir, "tombstones", `${shareId}.json`), "utf8");
      expect(persisted).not.toContain(ownerSecret);
      const config = readShareConfig({
        OCTANT_SHARE_DATA_DIR: dataDir,
        OCTANT_SHARE_HOST: "127.0.0.1",
        OCTANT_SHARE_PORT: "0",
        OCTANT_SHARE_USERCONTENT_PORT: "0",
      });
      if (config.status !== "ok") throw new Error("Fixture configuration refused.");
      service?.stop();
      service = startShareService(config.config, { clock: () => now });
      const replay = await fetch(`${service.publicUrl}/api/v1/shares`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(replay.status).toBe(410);
      expect(
        (
          await fetch(`${service.publicUrl}/api/v1/shares/${shareId}`, {
            method: "DELETE",
            headers: owner(ownerSecret),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${service.publicUrl}/api/v1/shares/${shareId}`, {
            method: "DELETE",
            headers: owner("z".repeat(43)),
          })
        ).status,
      ).toBe(403);
      expect(readdirSync(join(dataDir, "shares"))).toHaveLength(0);
    } finally {
      release();
      try {
        await creating;
      } finally {
        hashing.mockRestore();
      }
    }
  });

  test("replays an owned create without changing its receipt, payload or protected terms", async () => {
    start();
    const body = {
      ...createBody(undefined, { password: "correct horse" }),
      kind: "canvas-public-share-owned-create",
      shareId: createHash("sha256")
        .update("octant-canvas-public-share-id-v1\0" + "k".repeat(43))
        .digest()
        .subarray(0, 16)
        .toString("base64url"),
      ownerSecret: "k".repeat(43),
    };
    const [first, concurrent] = await Promise.all([create(body), create(body)]);
    expect(concurrent).toEqual(first);
    const path = join(dataDir, "shares", `${first.shareId}.json`);
    const stored = readFileSync(path, "utf8");
    expect(stored.includes(body.ownerSecret)).toBe(false);
    expect(stored.includes("correct horse")).toBe(false);
    now += DAY_MS;
    expect(await create(body)).toEqual(first);
    expect(readFileSync(path, "utf8")).toBe(stored);
    expect(readdirSync(join(dataDir, "shares"))).toHaveLength(1);
    const changed = await fetch(`${service?.publicUrl}/api/v1/shares/${first.shareId}`, {
      method: "PUT",
      headers: owner(body.ownerSecret),
      body: JSON.stringify({
        schemaVersion: 1,
        kind: "canvas-public-share-update",
        document: documentWith([heading], "Updated snapshot"),
        expiry: { kind: "never" },
      }),
    });
    expect(changed.status).toBe(200);
    const updated = readFileSync(path, "utf8");
    expect(await create(body)).toEqual(first);
    expect(readFileSync(path, "utf8")).toBe(updated);
  });

  test("refuses owned-create conflicts after checking the owner without mutating the link", async () => {
    start();
    const body = {
      ...createBody(),
      kind: "canvas-public-share-owned-create",
      shareId: createHash("sha256")
        .update("octant-canvas-public-share-id-v1\0" + "m".repeat(43))
        .digest()
        .subarray(0, 16)
        .toString("base64url"),
      ownerSecret: "m".repeat(43),
    };
    const created = await create(body);
    const path = join(dataDir, "shares", `${created.shareId}.json`);
    const stored = readFileSync(path, "utf8");
    for (const change of [
      { document: documentWith([heading], "Changed") },
      { expiry: { kind: "never" } },
      { password: "different password" },
    ]) {
      const response = await fetch(`${service?.publicUrl}/api/v1/shares`, {
        method: "POST",
        body: JSON.stringify({ ...body, ...change }),
      });
      expect(response.status).toBe(409);
      expect(readFileSync(path, "utf8")).toBe(stored);
    }
    const wrongOwner = await fetch(`${service?.publicUrl}/api/v1/shares`, {
      method: "POST",
      body: JSON.stringify({
        ...body,
        ownerSecret: "n".repeat(43),
        document: documentWith([heading], "Changed"),
      }),
    });
    expect(wrongOwner.status).toBe(403);
    expect(readFileSync(path, "utf8")).toBe(stored);
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

  test("keeps opening a link published under an earlier share version after the service learns a newer one", async () => {
    start();
    const body = createBody([heading, prose("Published before images")]);
    const created = await create({
      ...body,
      document: { ...body.document, shareSchemaVersion: 17 },
    });
    // The service reads the stored document back on every view and owner call.
    const view = await fetch(created.url);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("Published before images");
    const status = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      headers: owner(created.ownerSecret),
    });
    expect(status.status).toBe(200);
  });

  test("draws the images a share carries on the page and in design frames, and takes images past the document budget", async () => {
    start();
    // A picture larger than the whole document budget still leaves with its
    // share: images count against their own budget, not the text's.
    const bytes = Buffer.alloc(CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES + 1024, 7);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const data = bytes.toString("base64");
    const image = {
      imageRef: "image-1",
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data,
    };
    const cover = {
      blockId: "cover",
      schemaVersion: 30,
      kind: "image",
      alt: "A lighthouse at dusk",
      caption: "Cover art",
      imageRef: "image-1",
    };
    const framed = design({
      frames: [
        { frameId: "home", title: "Home", html: '<img src="octant-asset:hero" alt="Hero">' },
      ],
      assets: [{ assetId: "hero", imageRef: "image-1" }],
    });
    const body = createBody([cover, framed]);
    const created = await create({ ...body, document: { ...body.document, images: [image] } });
    const page = await (await fetch(created.url)).text();
    // Each image is served once at its own address on the share's path.
    const viewerImage = `/s/${created.shareId}/images/${image.sha256}`;
    expect(page).toContain(
      `<figure class="image"><img src="${viewerImage}" alt="A lighthouse at dusk"><figcaption>Cover art</figcaption></figure>`,
    );
    expect(page).not.toContain(data.slice(0, 64));
    const served = await fetch(`${service?.publicUrl}${viewerImage}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    // The browser asks again before reusing it, so a revoked link stops serving it.
    expect(served.headers.get("cache-control")).toBe("private, no-cache");
    expect(served.headers.get("etag")).toBe(`"${image.sha256}"`);
    const revalidated = await fetch(`${service?.publicUrl}${viewerImage}`, {
      headers: { "if-none-match": `"${image.sha256}"` },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("content-type")).toBeNull();
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
    // An image the share does not carry is not found.
    expect(
      (await fetch(`${service?.publicUrl}/s/${created.shareId}/images/${"0".repeat(64)}`)).status,
    ).toBe(404);

    const frameSrc = (
      /src="([^"]+)"/.exec(/<iframe[^>]*>/.exec(page)?.[0] ?? "")?.[1] ?? ""
    ).replace(/&amp;/g, "&");
    const frameResponse = await fetch(frameSrc);
    const frameImages = `${service?.usercontentUrl}/f/${created.shareId}/landing/images/`;
    expect(frameResponse.headers.get("content-security-policy")).toContain(
      `img-src data: ${frameImages};`,
    );
    const frame = await frameResponse.text();
    expect(frame).not.toContain("octant-asset:");
    const frameImage = /<img src="([^"]+)" alt="Hero">/.exec(frame)?.[1] ?? "";
    expect(frameImage.startsWith(`/f/${created.shareId}/landing/images/${image.sha256}?t=`)).toBe(
      true,
    );
    const drawn = await fetch(`${service?.usercontentUrl}${frameImage}`);
    expect(drawn.status).toBe(200);
    // A sandboxed frame's own images are a cross-origin load to it.
    expect(drawn.headers.get("access-control-allow-origin")).toBe("*");
    expect(Buffer.from(await drawn.arrayBuffer()).equals(bytes)).toBe(true);
    // A prototype left open past its frame token still draws its images.
    now += 11 * 60_000;
    expect((await fetch(`${service?.usercontentUrl}${frameImage}`)).status).toBe(200);
    // The frame's image answers only under the frame's token.
    expect(
      (await fetch(`${service?.usercontentUrl}${frameImage.split("?")[0] ?? ""}`)).status,
    ).toBe(403);

    // A revoked share serves its images no more.
    await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "DELETE",
      headers: owner(created.ownerSecret),
    });
    expect((await fetch(`${service?.publicUrl}${viewerImage}`)).status).toBe(404);
    expect((await fetch(`${service?.usercontentUrl}${frameImage}`)).status).toBe(404);
  });

  test("serves a protected link's images only with its password grant", async () => {
    start();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const image = {
      imageRef: "image-1",
      mediaType: "image/png",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data: bytes.toString("base64"),
    };
    const cover = {
      blockId: "cover",
      schemaVersion: 30,
      kind: "image",
      alt: "Cover",
      imageRef: "image-1",
    };
    const body = createBody([cover], { password: "correct horse" });
    const created = await create({ ...body, document: { ...body.document, images: [image] } });
    const address = `${service?.publicUrl}/s/${created.shareId}/images/${image.sha256}`;
    expect((await fetch(address)).status).toBe(404);
    const unlocked = await fetch(created.url, {
      method: "POST",
      body: new URLSearchParams({ password: "correct horse" }),
      redirect: "manual",
    });
    const cookie = (unlocked.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const granted = await fetch(address, { headers: { cookie } });
    expect(granted.status).toBe(200);
    expect(Buffer.from(await granted.arrayBuffer()).equals(bytes)).toBe(true);
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
    const secret = "v".repeat(43);
    const id = createHash("sha256")
      .update("octant-canvas-public-share-id-v1\0" + secret)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
    expect(
      (
        await fetch(`${service?.publicUrl}/api/v1/shares/${id}`, {
          method: "DELETE",
          headers: owner(secret),
        })
      ).status,
    ).toBe(429);
    expect(readdirSync(join(dataDir, "tombstones"))).toHaveLength(0);
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

  test("answers 410 removed after an operator takedown, and frees the link's bytes", async () => {
    // Room for one link and not two, so a second create passes only if the
    // running service counted the takedown.
    const oneLink = Buffer.byteLength(JSON.stringify(createBody().document), "utf8");
    start({ maxTotalBytes: Math.floor(oneLink * 1.5), operatorToken: OPERATOR_TOKEN });
    const created = await create();
    const operator = operatorEnv();
    expect(await runTakedown([created.shareId], operator)).toMatchObject({ code: 0 });
    const response = await fetch(created.url);
    expect(response.status).toBe(410);
    expect(await response.text()).toContain("This Canvas was removed.");
    await create();
    expect((await runTakedown([created.shareId], operator)).message).toContain("already gone");
    expect(await runTakedown(["C".repeat(22)], operator)).toMatchObject({ code: 1 });
  });

  test("refuses a takedown with the wrong operator token and keeps the link", async () => {
    start({ operatorToken: OPERATOR_TOKEN });
    const created = await create();
    const outcome = await runTakedown([created.shareId], {
      ...operatorEnv(),
      OCTANT_SHARE_OPERATOR_TOKEN: "w".repeat(40),
    });
    expect(outcome).toEqual({ code: 1, message: "The service refused the operator token." });
    expect((await fetch(created.url)).status).toBe(200);
  });

  test("a tombstone beside a surviving payload does not reopen the link", async () => {
    start();
    const created = await create();
    const payload = join(dataDir, "shares", `${created.shareId}.json`);
    const content = readFileSync(payload, "utf8");
    // A stop between the tombstone write and the payload delete leaves both files.
    writeFileSync(
      join(dataDir, "tombstones", `${created.shareId}.json`),
      JSON.stringify({ goneAt: new Date(now).toISOString(), reason: "taken-down" }),
    );
    expect((await fetch(created.url)).status).toBe(410);
    // The tombstone is final: the surviving payload is reconciled away, not served.
    expect(existsSync(payload)).toBe(false);
    const update = await fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "PUT",
      headers: owner(created.ownerSecret),
      body: JSON.stringify({
        schemaVersion: 1,
        kind: "canvas-public-share-update",
        document: documentWith([heading], "Back again"),
        expiry: { kind: "never" },
      }),
    });
    expect(update.status).not.toBe(200);
    // The same crash state is reconciled on restart, before any request.
    writeFileSync(payload, content);
    const restarted = new ShareStore(dataDir, { clock: () => now, maxTotalBytes: 1_000_000_000 });
    expect(restarted.lookup(created.shareId).status).toBe("gone");
    expect(existsSync(payload)).toBe(false);
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

describe("carried images in the store", () => {
  /** A PNG-signed raster of one repeated byte, with the entry a document carries it as. */
  function picture(ref: string, fill: number, size = 256 * 1024) {
    const bytes = Buffer.alloc(size, fill);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      bytes,
      sha256,
      entry: {
        imageRef: ref,
        mediaType: "image/png",
        byteLength: bytes.byteLength,
        sha256,
        data: bytes.toString("base64"),
      },
    };
  }
  type Picture = ReturnType<typeof picture>;

  const imageBlock = (ref: string) => ({
    blockId: `block-${ref}`,
    schemaVersion: 30,
    kind: "image",
    alt: "A picture",
    imageRef: ref,
  });

  /** A design that shows the first picture, and an image block for each other one. */
  function pictureDocument(
    pictures: ReadonlyArray<Picture>,
    // Text of several bytes a character, so a range counted in characters misses.
    text = 'Blåbær "quoted" 🫐 \\ and a line\nbreak',
  ) {
    const [first, ...others] = pictures.map((each) => each.entry.imageRef);
    return {
      ...documentWith([
        prose(text),
        design({
          frames: [{ frameId: "home", title: "Home", html: '<img src="octant-asset:hero">' }],
          assets: [{ assetId: "hero", imageRef: first }],
        }),
        ...others.map(imageBlock),
      ]),
      images: pictures.map((each) => each.entry),
    };
  }

  const createPictures = (pictures: ReadonlyArray<Picture>, extra = {}) =>
    create({ ...createBody(undefined, extra), document: pictureDocument(pictures) });

  const viewerImage = (id: string, sha256: string) =>
    `${service?.publicUrl}/s/${id}/images/${sha256}`;

  async function frameImage(created: Created): Promise<string> {
    const page = await (await fetch(created.url)).text();
    const src = /src="([^"]+)"/.exec(/<iframe[^>]*>/.exec(page)?.[0] ?? "")?.[1] ?? "";
    const frame = await (await fetch(src.replace(/&amp;/g, "&"))).text();
    return `${service?.usercontentUrl}${/<img src="([^"]+)"/.exec(frame)?.[1] ?? ""}`;
  }

  const update = (created: Created, document: unknown) =>
    fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "PUT",
      headers: owner(created.ownerSecret),
      body: JSON.stringify({
        schemaVersion: 1,
        kind: "canvas-public-share-update",
        document,
        expiry: { kind: "days", days: 30 },
      }),
    });

  const revoke = (created: Created) =>
    fetch(`${service?.publicUrl}/api/v1/shares/${created.shareId}`, {
      method: "DELETE",
      headers: owner(created.ownerSecret),
    });

  const sharePath = (id: string) => join(dataDir, "shares", `${id}.json`);

  function serve(overrides: Partial<ShareConfig> = {}): void {
    const config = readShareConfig({
      OCTANT_SHARE_DATA_DIR: dataDir,
      OCTANT_SHARE_PORT: "0",
      OCTANT_SHARE_USERCONTENT_PORT: "0",
    });
    if (config.status !== "ok") throw new Error("Fixture configuration refused.");
    service?.stop();
    service = startShareService({ ...config.config, ...overrides }, { clock: () => now });
  }

  /** The bytes read from share files while `act` runs. */
  async function shareBytesRead(act: () => Promise<void>): Promise<number> {
    let total = 0;
    const whole = fs.readFileSync;
    const part = fs.readSync;
    const spies = [
      spyOn(fs, "readFileSync").mockImplementation(((path: string, ...rest: never[]) => {
        const content = whole(path, ...rest);
        if (String(path).startsWith(join(dataDir, "shares"))) total += content.length;
        return content;
      }) as never),
      spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof part>) => {
        const count = part(...args);
        total += count;
        return count;
      }) as never),
    ];
    try {
      await act();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    return total;
  }

  /** Every file under the data directory whose content names `text`. */
  function filesNaming(text: string): ReadonlyArray<string> {
    return readdirSync(dataDir, { recursive: true, withFileTypes: true })
      .filter((each) => each.isFile())
      .map((each) => join(each.parentPath, each.name))
      .filter((path) => readFileSync(path, "utf8").includes(text));
  }

  /** The share as the version before byte-range reads stored it: one plain JSON document. */
  function storeAsEarlierVersion(id: string): void {
    const stored = JSON.parse(readFileSync(sharePath(id), "utf8")) as Record<string, unknown>;
    const { document, createdAt, updatedAt, expiresAt, byteLength, ...rest } = stored;
    const { passwordHash, ownerSecretHash, revision, viewCount, creation } = rest;
    writeFileSync(
      sharePath(id),
      JSON.stringify({
        ...(creation === undefined ? {} : { creation }),
        document: decodeCanvasPublicShareDocument(document),
        createdAt,
        updatedAt,
        expiresAt,
        byteLength,
        passwordHash,
        ownerSecretHash,
        revision,
        viewCount,
      }),
    );
  }

  test("reads only the image a reader asks for and the share's small metadata", async () => {
    start();
    const pictures = [1, 2, 3, 4].map((fill) => picture(`image-${String(fill)}`, fill));
    const [first, second] = pictures as [Picture, Picture];
    const created = await createPictures(pictures);
    const inFrame = await frameImage(created);
    const imageText = first.entry.data.length;

    const viewed = await shareBytesRead(async () => {
      const response = await fetch(viewerImage(created.shareId, second.sha256));
      expect(Buffer.from(await response.arrayBuffer()).equals(second.bytes)).toBe(true);
    });
    expect(viewed).toBeGreaterThanOrEqual(imageText);
    expect(viewed).toBeLessThan(imageText + 8 * 1024);

    const framed = await shareBytesRead(async () => {
      const response = await fetch(inFrame);
      expect(Buffer.from(await response.arrayBuffer()).equals(first.bytes)).toBe(true);
    });
    expect(framed).toBeGreaterThanOrEqual(imageText);
    expect(framed).toBeLessThan(imageText + 8 * 1024);

    const revalidated = await shareBytesRead(async () => {
      const response = await fetch(viewerImage(created.shareId, second.sha256), {
        headers: { "if-none-match": `"${second.sha256}"` },
      });
      expect(response.status).toBe(304);
    });
    expect(revalidated).toBeLessThan(8 * 1024);
  });

  test("reads no image for a reader without the link's password or for an image the share lacks", async () => {
    start();
    const image = picture("image-1", 1);
    const locked = await createPictures([image], { password: "correct horse" });
    const open = await createPictures([image]);
    for (const [id, sha256] of [
      [locked.shareId, image.sha256],
      [open.shareId, "0".repeat(64)],
    ] as const) {
      const read = await shareBytesRead(async () => {
        expect((await fetch(viewerImage(id, sha256))).status).toBe(404);
      });
      expect(read).toBeLessThan(8 * 1024);
    }
  });

  test("closes the share file after every answer", async () => {
    start();
    const image = picture("image-1", 1);
    const created = await createPictures([image]);
    const path = sharePath(created.shareId);
    const opened = spyOn(fs, "openSync");
    const closed = spyOn(fs, "closeSync");
    try {
      const store = new ShareStore(dataDir, { clock: () => now, maxTotalBytes: 1_000_000_000 });
      opened.mockClear();
      closed.mockClear();
      store.withImages(created.shareId, (share) => share.images[0]?.read());
      expect(() =>
        store.withImages(created.shareId, () => {
          throw new Error("The answer failed.");
        }),
      ).toThrow("The answer failed.");
      writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, "utf8")), null, 2));
      store.withImages(created.shareId, (share) => share.images[0]?.read());
      const files = opened.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value] : [],
      );
      expect(files.length).toBeGreaterThanOrEqual(3);
      expect(closed.mock.calls.map(([fd]) => fd)).toEqual(files);
    } finally {
      opened.mockRestore();
      closed.mockRestore();
    }
  });

  test("reads an image from the revision it was opened at when an update lands before the read", async () => {
    start();
    const before = picture("image-1", 1);
    const after = picture("image-1", 2, 300 * 1024);
    const created = await createPictures([before]);
    const store = new ShareStore(dataDir, { clock: () => now, maxTotalBytes: 1_000_000_000 });
    const document = decodeCanvasPublicShareDocument(pictureDocument([after]));
    const bytes = store.withImages(created.shareId, (share) => {
      store.replace(created.shareId, (current) => ({ ...current, document }));
      return share.images[0]?.read();
    });
    expect(bytes?.equals(before.bytes)).toBe(true);
    expect(
      store.withImages(created.shareId, (share) => share.images[0]?.read())?.equals(after.bytes),
    ).toBe(true);
  });

  test("picks the same image whichever layout holds it when block ids and digests repeat", async () => {
    start();
    const [first, second] = [picture("image-1", 1), picture("image-2", 2)];
    // Two entries under one digest, and two designs under one block id: the
    // first entry and the first design count.
    const twin = { ...second.entry, imageRef: "image-3", sha256: first.sha256 };
    const images = [first.entry, second.entry, twin];
    const named = (imageRef: string) =>
      design({
        frames: [{ frameId: "home", title: "Home", html: '<img src="octant-asset:hero">' }],
        assets: [{ assetId: "hero", imageRef }],
      });
    const document = {
      ...documentWith([named("image-3"), named("image-2"), imageBlock("image-1")]),
      images,
    };
    const created = await create({ ...createBody(), document });
    const inFrame = await frameImage(created);
    const served = async () => ({
      viewer: await (await fetch(viewerImage(created.shareId, first.sha256))).bytes(),
      frame: await (await fetch(inFrame)).bytes(),
      otherDesign: (await fetch(inFrame.replace(first.sha256, second.sha256))).status,
    });
    const indexed = await served();
    expect(first.bytes.equals(indexed.viewer)).toBe(true);
    expect(second.bytes.equals(indexed.frame)).toBe(true);
    expect(indexed.otherDesign).toBe(404);
    storeAsEarlierVersion(created.shareId);
    expect(await served()).toEqual(indexed);
  });

  test("serves no image of a share whose document the service can no longer read", async () => {
    start();
    const image = picture("image-1", 1);
    const created = await createPictures([image]);
    const path = sharePath(created.shareId);
    // The same length, so the image's recorded range still fits.
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "canvas-public-share-document",
        "canvas-public-share-DOCUMENT",
      ),
    );
    for (const restarted of [false, true]) {
      if (restarted) serve();
      expect((await fetch(`${service?.publicUrl}/s/${created.shareId}`)).status).toBe(404);
      expect((await fetch(viewerImage(created.shareId, image.sha256))).status).toBe(404);
    }
  });

  test("serves a frame only the images its own design names", async () => {
    start();
    const pictures = [picture("image-1", 1), picture("image-2", 2)] as const;
    const created = await createPictures(pictures);
    const inFrame = await frameImage(created);
    expect((await fetch(inFrame)).status).toBe(200);
    expect((await fetch(inFrame.replace(pictures[0].sha256, pictures[1].sha256))).status).toBe(404);
    expect((await fetch(inFrame.replace("/landing/", "/block-image-2/"))).status).toBe(403);
  });

  for (const ending of ["revoke", "expiry", "takedown", "expiry sweep"] as const) {
    test(`leaves no image byte on disk and answers 404 for its images after ${ending}`, async () => {
      start({ operatorToken: OPERATOR_TOKEN });
      const image = picture("image-1", 1);
      const created = await createPictures([image]);
      const inFrame = await frameImage(created);
      expect(filesNaming(image.entry.data.slice(-64))).toEqual([sharePath(created.shareId)]);
      if (ending === "revoke") expect((await revoke(created)).status).toBe(200);
      if (ending === "takedown") {
        expect(await runTakedown([created.shareId], operatorEnv())).toMatchObject({ code: 0 });
      }
      if (ending === "expiry" || ending === "expiry sweep") now += 31 * DAY_MS;
      if (ending === "expiry sweep") {
        // The sweep at start removes it before any request asks.
        serve();
        expect(filesNaming(image.entry.data.slice(-64))).toEqual([]);
      }
      expect((await fetch(viewerImage(created.shareId, image.sha256))).status).toBe(404);
      const framePath = new URL(inFrame);
      expect(
        (await fetch(`${service?.usercontentUrl}${framePath.pathname}${framePath.search}`)).status,
      ).toBe(404);
      expect(filesNaming(image.entry.data.slice(-64))).toEqual([]);
      expect((await fetch(`${service?.publicUrl}/s/${created.shareId}`)).status).toBe(410);
    });
  }

  test("a tombstone beside a surviving payload stops its images and removes them", async () => {
    start();
    const image = picture("image-1", 1);
    const created = await createPictures([image]);
    writeFileSync(
      join(dataDir, "tombstones", `${created.shareId}.json`),
      JSON.stringify({ goneAt: new Date(now).toISOString(), reason: "revoked" }),
    );
    expect((await fetch(viewerImage(created.shareId, image.sha256))).status).toBe(404);
    expect(filesNaming(image.entry.data.slice(-64))).toEqual([]);
  });

  test("replaces a share's images with its update and keeps no copy of the old ones", async () => {
    start();
    const before = picture("image-1", 1);
    const after = picture("image-1", 2);
    const created = await createPictures([before]);
    expect((await update(created, pictureDocument([after]))).status).toBe(200);
    expect((await fetch(viewerImage(created.shareId, before.sha256))).status).toBe(404);
    const response = await fetch(viewerImage(created.shareId, after.sha256));
    expect(Buffer.from(await response.arrayBuffer()).equals(after.bytes)).toBe(true);
    expect(filesNaming(before.entry.data.slice(-64))).toEqual([]);
  });

  test("opens a share the earlier version stored, serves its images, and lets its owner manage it", async () => {
    start();
    const pictures = [picture("image-1", 1), picture("image-2", 2)] as const;
    const created = await createPictures(pictures);
    storeAsEarlierVersion(created.shareId);
    const stored = readFileSync(sharePath(created.shareId), "utf8");
    expect((await fetch(created.url)).status).toBe(200);
    for (const image of pictures) {
      const response = await fetch(viewerImage(created.shareId, image.sha256));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(image.bytes)).toBe(true);
    }
    const inFrame = await frameImage(created);
    expect((await fetch(inFrame)).status).toBe(200);
    expect((await fetch(inFrame.replace(pictures[0].sha256, pictures[1].sha256))).status).toBe(404);
    // Reading never rewrites what the earlier version stored.
    expect(readFileSync(sharePath(created.shareId), "utf8")).toBe(stored);
    expect((await update(created, pictureDocument([pictures[0]]))).status).toBe(200);
    expect((await fetch(viewerImage(created.shareId, pictures[0].sha256))).status).toBe(200);
    expect((await revoke(created)).status).toBe(200);
    expect((await fetch(created.url)).status).toBe(410);
  });

  test("stores a share the earlier version still reads whole, images and text alike", async () => {
    start();
    const pictures = [picture("image-1", 1), picture("image-2", 2)] as const;
    const document = pictureDocument(pictures);
    const created = await create({ ...createBody(), document });
    // The earlier version parses the file as JSON, decodes `document`, and
    // ignores keys it does not know.
    const stored = JSON.parse(readFileSync(sharePath(created.shareId), "utf8")) as {
      document: unknown;
      revision: number;
      passwordHash: string | null;
      byteLength: number;
    };
    expect(decodeCanvasPublicShareDocument(stored.document)).toEqual(
      decodeCanvasPublicShareDocument(document),
    );
    expect(stored).toMatchObject({ revision: 1, passwordHash: null });
    for (const image of pictures) {
      const response = await fetch(viewerImage(created.shareId, image.sha256));
      expect(Buffer.from(await response.arrayBuffer()).equals(image.bytes)).toBe(true);
    }
  });

  test("counts a share's image bytes once toward the storage cap, also after a restart", async () => {
    const image = picture("image-1", 1);
    const maxTotalBytes = Math.floor(image.entry.data.length * 1.9);
    start({ maxTotalBytes });
    const created = await createPictures([image]);
    const refusedStatus = async () =>
      (
        await fetch(`${service?.publicUrl}/api/v1/shares`, {
          method: "POST",
          body: JSON.stringify({ ...createBody(), document: pictureDocument([image]) }),
        })
      ).status;
    expect(await refusedStatus()).toBe(503);
    serve({ maxTotalBytes });
    expect(await refusedStatus()).toBe(503);
    expect(statSync(sharePath(created.shareId)).size).toBeLessThan(
      image.entry.data.length + 16 * 1024,
    );
    // An update without images gives their room back, and so does a revoke.
    expect((await update(created, documentWith([heading]))).status).toBe(200);
    const second = await createPictures([image]);
    expect(await refusedStatus()).toBe(503);
    expect((await revoke(second)).status).toBe(200);
    await createPictures([image]);
  });

  test("gives every reader whole images while the owner updates and then revokes the link", async () => {
    start();
    const pictures = [picture("image-1", 1), picture("image-1", 2, 300 * 1024)] as const;
    const created = await createPictures([pictures[0]]);
    let revoked = false;
    const reader = async (image: Picture) => {
      const seen = new Set<number>();
      for (let read = 0; read < 30; read += 1) {
        const startedAfterRevoke = revoked;
        const response = await fetch(viewerImage(created.shareId, image.sha256));
        const body = Buffer.from(await response.arrayBuffer());
        seen.add(response.status);
        if (response.status === 200) {
          expect(startedAfterRevoke).toBe(false);
          expect(body.equals(image.bytes)).toBe(true);
        } else expect(response.status).toBe(404);
      }
      return seen;
    };
    const writer = async () => {
      for (let write = 1; write <= 12; write += 1) {
        const next = pictures[write % 2] ?? pictures[0];
        expect((await update(created, pictureDocument([next]))).status).toBe(200);
      }
      expect((await revoke(created)).status).toBe(200);
      revoked = true;
    };
    const [, ...seen] = await Promise.all([
      writer(),
      ...pictures.flatMap((image) => [reader(image), reader(image), reader(image)]),
    ]);
    expect(seen.some((statuses) => statuses.has(200))).toBe(true);
    for (const image of pictures) {
      expect((await fetch(viewerImage(created.shareId, image.sha256))).status).toBe(404);
      expect(filesNaming(image.entry.data.slice(-64))).toEqual([]);
    }
  });

  test("keeps the published images and none of the new ones when an update cannot be written", async () => {
    start();
    const [kept, refused] = [picture("image-1", 1), picture("image-1", 2)];
    const created = await createPictures([kept]);
    const renaming = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("No space left on the device.");
    });
    try {
      expect((await update(created, pictureDocument([refused]))).status).toBe(503);
    } finally {
      renaming.mockRestore();
    }
    expect(filesNaming(refused.entry.data.slice(-64))).toEqual([]);
    expect((await fetch(viewerImage(created.shareId, kept.sha256))).status).toBe(200);
  });

  test("removes an unfinished write's image bytes at the next start and keeps the finished share", async () => {
    start();
    const kept = picture("image-1", 1);
    const unfinished = picture("image-1", 2);
    const created = await createPictures([kept]);
    // What a stop between the temporary write and its rename leaves behind.
    writeFileSync(
      `${sharePath(created.shareId)}.0123456789ab.tmp`,
      JSON.stringify({ document: pictureDocument([unfinished]) }),
    );
    writeFileSync(join(dataDir, "shares", "operator-notes.tmp"), "not the service's file");
    serve();
    expect(readdirSync(join(dataDir, "shares")).sort()).toEqual(
      [`${created.shareId}.json`, "operator-notes.tmp"].sort(),
    );
    expect((await fetch(viewerImage(created.shareId, kept.sha256))).status).toBe(200);
  });

  test("never misreads an image when its share file was reformatted, resized or truncated by hand", async () => {
    start();
    const image = picture("image-1", 1);
    const created = await createPictures([image]);
    const path = sharePath(created.shareId);
    const whole = readFileSync(path, "utf8");
    const served = async () => {
      const response = await fetch(viewerImage(created.shareId, image.sha256));
      return response.status === 200 ? image.bytes.equals(await response.bytes()) : response.status;
    };
    const from = Number(/"start":(\d+)/.exec(whole)?.[1]);
    // A range past the end, a longer document, and a reformatted file are read whole.
    writeFileSync(
      path,
      whole.replace(`"start":${String(from)}`, `"start":${"9".repeat(String(from).length)}`),
    );
    expect(await served()).toBe(true);
    writeFileSync(path, whole.replace("Quarterly plan", "Quarterly plan, longer"));
    expect(await served()).toBe(true);
    writeFileSync(path, JSON.stringify(JSON.parse(whole), null, 2));
    expect(await served()).toBe(true);
    // A range inside the file that is not a whole quoted text is no image.
    writeFileSync(path, whole.replace(`"start":${String(from)}`, `"start":${String(from - 1)}`));
    expect(await served()).toBe(404);
    // A truncated file is no share at all.
    writeFileSync(path, whole.slice(0, -100_000));
    expect(await served()).toBe(404);
  });

  test("refuses image addresses whose id or digest is not one the service mints", async () => {
    start();
    const image = picture("image-1", 1);
    const created = await createPictures([image]);
    // A share file elsewhere that a path in the id would reach.
    writeFileSync(join(dataDir, "outside.json"), readFileSync(sharePath(created.shareId)));
    for (const id of ["..%2foutside", "%2e%2e%2foutside", "..", `${created.shareId}%00`]) {
      expect((await fetch(viewerImage(id, image.sha256))).status).toBe(404);
      expect(
        (await fetch(`${service?.usercontentUrl}/f/${id}/landing/images/${image.sha256}?t=x`))
          .status,
      ).toBe(404);
    }
    for (const digest of ["..%2f..%2fframe-key", image.sha256.toUpperCase(), "0"]) {
      expect((await fetch(viewerImage(created.shareId, digest))).status).toBe(404);
    }
    writeFileSync(join(dataDir, "shares", "short.json"), readFileSync(sharePath(created.shareId)));
    const store = new ShareStore(dataDir, { clock: () => now, maxTotalBytes: 1_000_000_000 });
    for (const id of ["../outside", "../shares/short", "short"]) {
      expect(store.withImages(id, () => "read")).toBeUndefined();
    }
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

describe("design frame pages", () => {
  test("names each carried image by its address however often the frame shows it, and draws nothing a comment names", () => {
    const image = {
      imageRef: "image-1",
      mediaType: "image/png",
      byteLength: 12,
      sha256: "a".repeat(64),
      data: "iVBORw0KGgoBAgME",
    } as const;
    const address = () => "/f/share/landing/images/aaa?t=token";
    // A frame naming one image a hundred times, under a dozen asset ids.
    const aliases = Array.from({ length: 12 }, (_, index) => `alias-${String(index)}`);
    const page = renderDesignFramePage(
      design({
        schemaVersion: 30,
        frames: [
          {
            frameId: "home",
            title: "Home",
            html:
              '<img src="octant-asset:hero" alt="">'.repeat(100) +
              aliases.map((id) => `<img src="octant-asset:${id}" alt="">`).join("") +
              '<!-- <img src="octant-asset:hero" alt=""> -->',
          },
        ],
        styles: ".hero { background: url(octant-asset:hero); } /* url(octant-asset:hero) */",
        assets: [
          { assetId: "hero", imageRef: "image-1" },
          ...aliases.map((assetId) => ({ assetId, imageRef: "image-1" })),
        ],
      }) as never,
      [image as never],
      address,
    );
    expect(page.split(address()).length - 1).toBe(113);
    expect(page.length).toBeLessThan(16 * 1024);
    expect(page).not.toContain(image.data);
    expect(page).toContain('<!-- <img src="octant-asset:hero" alt=""> -->');
    expect(page).toContain("/* url(octant-asset:hero) */");
  });
});
