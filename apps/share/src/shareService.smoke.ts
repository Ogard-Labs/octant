import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_SHARE_SCHEMA_VERSION } from "@octant/contracts/canvas-share";
import { startShareService } from "./server.ts";

// Starts the service on loopback ports with a temporary data directory,
// publishes a Canvas, views it, revokes it, and reads 410.

const dataDir = mkdtempSync(join(tmpdir(), "octant-share-smoke-"));
const service = startShareService({
  host: "127.0.0.1",
  port: 0,
  usercontentPort: 0,
  publicOrigin: undefined,
  usercontentOrigin: undefined,
  dataDir,
  maxDocumentBytes: 262_144,
  maxTotalBytes: 1_000_000_000,
  abuseContact: undefined,
  trustProxy: false,
  operatorPort: 0,
  operatorToken: undefined,
});

const title = "Smoke test Canvas";
const body = {
  schemaVersion: 1,
  kind: "canvas-public-share-create",
  expiry: { kind: "days", days: 1 },
  document: {
    schemaVersion: 1,
    kind: "canvas-public-share-document",
    shareSchemaVersion: CANVAS_SHARE_SCHEMA_VERSION,
    title,
    summary: "A Canvas published by the smoke test.",
    publishedAt: new Date().toISOString(),
    blocks: [
      { blockId: "h", schemaVersion: 1, kind: "heading", level: 1, text: "Overview" },
      {
        blockId: "p",
        schemaVersion: 1,
        kind: "rich-text",
        text: "First paragraph.\n\nSecond paragraph.",
      },
      {
        blockId: "t",
        schemaVersion: 1,
        kind: "table",
        columns: [
          { id: "a", label: "Item", type: "text" },
          { id: "b", label: "Count", type: "number" },
        ],
        rows: [["Widgets", 3]],
      },
      {
        blockId: "d",
        schemaVersion: 1,
        kind: "design",
        title: "Landing",
        size: "desktop",
        frames: [{ frameId: "home", title: "Home", html: "<h1>Hello</h1>" }],
      },
    ],
  },
};

let failure: string | undefined;
try {
  const created = await fetch(`${service.publicUrl}/api/v1/shares`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const share = (await created.json()) as { url: string; shareId: string; ownerSecret: string };
  console.log(`create: ${String(created.status)} ${share.url}`);
  if (created.status !== 201) failure = "create did not answer 201";

  const viewed = await fetch(share.url);
  const page = await viewed.text();
  console.log(`view: ${String(viewed.status)}, contains title: ${String(page.includes(title))}`);
  if (viewed.status !== 200 || !page.includes(title)) failure ??= "viewer did not show the title";

  const revoked = await fetch(`${service.publicUrl}/api/v1/shares/${share.shareId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${share.ownerSecret}` },
  });
  console.log(`revoke: ${String(revoked.status)}`);
  if (revoked.status !== 200) failure ??= "revoke did not answer 200";

  const gone = await fetch(share.url);
  console.log(`view after revoke: ${String(gone.status)}`);
  if (gone.status !== 410) failure ??= "revoked link did not answer 410";
} catch (error) {
  failure = error instanceof Error ? error.message : "unknown failure";
} finally {
  service.stop();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failure === undefined ? "PASS" : `FAIL: ${failure}`);
process.exit(failure === undefined ? 0 : 1);
