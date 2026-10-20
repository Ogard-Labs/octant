import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { decodeCanvasId, decodeCanvasVersionId, type CanvasBlock } from "@octant/contracts/canvas";
import { decodeCanvasExportPrepareRequest } from "@octant/contracts/canvas-export";
import {
  decodeCanvasPublicShareDocument,
  decodeCanvasPublicShareServiceUrl,
  type CanvasPublicShareDocument,
  type CanvasPublicShareId,
} from "@octant/contracts/canvas-public-share";
import { AggregateVersion, EventActor, ReplayCursor, decodeUtcTimestamp } from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CanvasExportEventStore, registerCanvasExportEvents } from "./canvasExportEventStore";
import { CanvasExportService, type CanvasExportDocument } from "./canvasExportService";
import { canvasExportTargetBindings } from "./canvasExportTargets";
import { createCanvasExportFilePort } from "./canvasExportFilePort";
import {
  CanvasPublicShareService,
  registerCanvasPublicShareEvents,
  type CanvasPublicShareSecretStore,
} from "./canvasPublicShareService";
import type {
  CanvasPublicShareCallOutcome,
  CanvasPublicShareServicePort,
} from "./canvasPublicShareServicePort";
import { PUBLIC_LINK_EXPORT_TARGET_ID } from "./publicLinkExportTarget";

const directories: string[] = [];
const now = "2026-10-20T10:00:00.000Z";
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const versionId = decodeCanvasVersionId("22222222-2222-4222-8222-222222222222");
const projectId = "33333333-3333-4333-8333-333333333333";
const sourceId = "77777777-7777-4777-8777-777777777777";
const decodeActor = Schema.decodeUnknownSync(EventActor);
const localActor = decodeActor({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const remoteActor = decodeActor({
  kind: "remote-device",
  actorId: "16161616-1616-4161-8161-161616161616",
  deviceId: "16161616-1616-4161-8161-161616161616",
});
const shareId = "AbCdEfGhIjKlMnOpQrSt_-" as CanvasPublicShareId;
const ownerSecret = "o".repeat(43);
const serviceUrl = decodeCanvasPublicShareServiceUrl("https://canvas.octant.sh");

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-public-share-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function canvas(blocks: ReadonlyArray<unknown>): CanvasExportDocument {
  return {
    canvasId,
    versionId,
    sequence: 1,
    title: "Launch plan",
    blocks: blocks as ReadonlyArray<CanvasBlock>,
  };
}

const sourcedCanvas = canvas([
  { blockId: "intro", schemaVersion: 1, kind: "heading", level: 1, text: "Launch" },
  { blockId: "src", schemaVersion: 1, kind: "source-reference", label: "Brief", sourceId },
]);

/** A stand-in for the share service that records each call and answers as told. */
function fakeService() {
  const calls: Array<{ readonly kind: string; readonly input: Record<string, unknown> }> = [];
  let revokeAnswer: CanvasPublicShareCallOutcome<{ readonly shareId: CanvasPublicShareId }> = {
    kind: "ok",
    value: { shareId },
  };
  const port: CanvasPublicShareServicePort = {
    create: async (input) => {
      calls.push({ kind: "create", input: { ...input } });
      return {
        kind: "ok",
        value: {
          schemaVersion: 1,
          kind: "canvas-public-share-created",
          shareId,
          url: decodeCanvasPublicShareServiceUrl(`https://canvas.octant.sh/s/${shareId}`),
          ownerSecret: ownerSecret as never,
          expiresAt: decodeUtcTimestamp("2026-11-19T10:00:00.000Z"),
        },
      };
    },
    update: async (input) => {
      calls.push({ kind: "update", input: { ...input } });
      return {
        kind: "ok",
        value: {
          schemaVersion: 1,
          kind: "canvas-public-share-updated",
          shareId,
          url: decodeCanvasPublicShareServiceUrl(`https://canvas.octant.sh/s/${shareId}`),
          expiresAt: null,
          updatedAt: decodeUtcTimestamp(now),
          passwordProtected: false,
        },
      };
    },
    revoke: async (input) => {
      calls.push({ kind: "revoke", input: { ...input } });
      return revokeAnswer;
    },
  };
  return {
    port,
    calls,
    answerRevokeWith: (answer: typeof revokeAnswer) => {
      revokeAnswer = answer;
    },
  };
}

function memorySecrets(): CanvasPublicShareSecretStore & { readonly held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    set: async (ref, secret) => {
      held.set(ref, secret);
    },
    resolve: async (ref) => {
      const secret = held.get(ref);
      if (secret === undefined) throw new Error("missing");
      return secret;
    },
    delete: async (ref) => {
      held.delete(ref);
    },
  };
}

function harness(options?: {
  readonly connection?: SqliteConnection;
  readonly service?: ReturnType<typeof fakeService>;
  readonly secrets?: ReturnType<typeof memorySecrets>;
  readonly doc?: CanvasExportDocument;
}) {
  const connection = options?.connection ?? openConnection();
  const service = options?.service ?? fakeService();
  const secrets = options?.secrets ?? memorySecrets();
  const journal = new Journal({
    connection,
    registry: registerCanvasPublicShareEvents(registerCanvasExportEvents(new EventRegistry())),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const links = new CanvasPublicShareService({
    journal,
    service: service.port,
    secrets,
    uuid: () => crypto.randomUUID(),
    clock: () => decodeUtcTimestamp(now),
    actor: localActor,
  });
  const home = tmpdir();
  const exports = new CanvasExportService({
    load: () => options?.doc ?? sourcedCanvas,
    targets: (id) =>
      canvasExportTargetBindings(
        {
          folderFor: () => undefined,
          files: createCanvasExportFilePort(),
          home,
          standingOutsideApproval: false,
          newTempId: () => crypto.randomUUID(),
          publicLinks: links,
        },
        id,
      ),
    eventStore: new CanvasExportEventStore({ journal, uuid: () => crypto.randomUUID() }),
    uuid: () => crypto.randomUUID(),
    clock: () => decodeUtcTimestamp(now),
  });
  const turnOn = () =>
    links.changeSettings({
      schemaVersion: 1,
      kind: "set-canvas-public-link-settings",
      enabled: true,
      serviceUrl,
      expectedVersion: links.settings().version,
    });
  const journalText = () =>
    JSON.stringify(
      journal.replay(Schema.decodeUnknownSync(ReplayCursor)({ afterSequence: 0, limit: 500 })),
    );
  return { connection, service, secrets, links, exports, turnOn, journalText };
}

const prepare = (format: "share-document" | "markdown" = "share-document") =>
  decodeCanvasExportPrepareRequest({
    schemaVersion: 1,
    kind: "canvas-export-prepare",
    canvasId,
    versionId,
    expectedSequence: 1,
    targetId: PUBLIC_LINK_EXPORT_TARGET_ID,
    format,
  });

async function publish(
  h: ReturnType<typeof harness>,
  link?: Parameters<CanvasExportService["decide"]>[0]["link"],
) {
  const prepared = h.exports.prepare(prepare(), true, "local-window");
  if (prepared.kind !== "approval") throw new Error(`Expected a card, got ${prepared.message}`);
  const decided = await h.exports.decide({
    canvasId,
    approvalId: prepared.card.approvalId,
    decision: "approved",
    permitted: true,
    actor: localActor,
    ...(link === undefined ? {} : { link }),
  });
  return { card: prepared.card, decided };
}

describe("public links", () => {
  it("offers no destination and sends nothing while Public links is off", () => {
    const h = harness();
    const offers = h.exports.offers(canvasId);
    expect(offers?.targets.map((target) => String(target.targetId))).not.toContain(
      PUBLIC_LINK_EXPORT_TARGET_ID,
    );
    const prepared = h.exports.prepare(prepare(), true, "local-window");
    expect(prepared.kind).toBe("refused");
    expect(h.service.calls).toEqual([]);
  });

  it("sends nothing until the person approves the card that names the service, audience, and expiry", async () => {
    const h = harness();
    h.turnOn();
    const prepared = h.exports.prepare(prepare(), true, "local-window");
    if (prepared.kind !== "approval") throw new Error("Expected an approval card.");
    expect(prepared.card.destinationLabel).toBe("Public link");
    expect(prepared.card.destinationAccount).toBe("canvas.octant.sh");
    expect(prepared.card.destinationVisibility).toBe("secret");
    expect(prepared.card.destinationNote).toContain("Anyone with the link");
    expect(prepared.card.destinationNote).toContain("can read it");
    expect(prepared.card.destinationLinkTerms?.defaultExpiryDays).toBe(30);
    expect(h.service.calls).toEqual([]);

    const denied = await h.exports.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "denied",
      permitted: true,
      actor: localActor,
    });
    expect(denied.kind).toBe("denied");
    expect(h.service.calls).toEqual([]);
  });

  it("sends exactly the filtered share document the card showed, without host, Project, or source identity", async () => {
    const h = harness();
    h.turnOn();
    const { card, decided } = await publish(h);
    expect(decided.kind).toBe("exported");
    const sent = h.service.calls[0]?.input.document as CanvasPublicShareDocument;
    expect(decodeCanvasPublicShareDocument(JSON.parse(card.payload))).toEqual(sent);
    const wire = JSON.stringify(sent);
    for (const id of [String(canvasId), String(versionId), projectId, sourceId]) {
      expect(wire).not.toContain(id);
    }
    expect(h.service.calls[0]?.input.expiry).toEqual({ kind: "days", days: 30 });
  });

  it("carries a design's markup only on a card that says it leaves as written, and refuses an action block", async () => {
    const design = {
      blockId: "screen",
      schemaVersion: 16,
      kind: "design",
      title: "Home",
      size: "phone",
      frames: [{ frameId: "home", title: "Home", html: "<main><h1>Hi</h1></main>" }],
    };
    const withDesign = harness({ doc: canvas([design]) });
    withDesign.turnOn();
    const prepared = withDesign.exports.prepare(prepare(), true, "local-window");
    if (prepared.kind !== "approval") throw new Error("Expected an approval card.");
    expect(prepared.card.writesDesignMarkup).toBe(true);

    const withAction = harness({
      doc: canvas([
        {
          blockId: "go",
          schemaVersion: 1,
          kind: "action",
          label: "Refresh",
          command: { command: "canvas.request-refresh" },
        },
      ]),
    });
    withAction.turnOn();
    expect(withAction.exports.prepare(prepare(), true, "local-window").kind).toBe("refused");
    expect(withAction.service.calls).toEqual([]);
  });

  it("refuses to publish from a paired device, at prepare and at approval", async () => {
    const h = harness();
    h.turnOn();
    expect(h.exports.prepare(prepare(), true, "remote-device")).toMatchObject({
      kind: "refused",
      code: "unauthorized",
    });
    const prepared = h.exports.prepare(prepare(), true, "local-window");
    if (prepared.kind !== "approval") throw new Error("Expected an approval card.");
    const decided = await h.exports.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: remoteActor,
    });
    expect(decided).toMatchObject({ kind: "refused", code: "unauthorized" });
    expect(h.service.calls).toEqual([]);
  });

  it("keeps the owner secret in the credential store and never in the journal", async () => {
    const h = harness();
    h.turnOn();
    await publish(h, { expiry: { kind: "never" }, password: "correct horse" });
    expect([...h.secrets.held.values()]).toEqual([ownerSecret]);
    const journal = h.journalText();
    expect(journal).not.toContain(ownerSecret);
    expect(journal).not.toContain("correct horse");
    expect(h.service.calls[0]?.input).toMatchObject({
      expiry: { kind: "never" },
      password: "correct horse",
    });
    expect(h.links.list(canvasId).shares[0]).toMatchObject({
      status: "active",
      passwordProtected: true,
    });
  });

  it("updates the same link when the Canvas already has one, and the card names it", async () => {
    const h = harness();
    h.turnOn();
    await publish(h);
    const { card, decided } = await publish(h);
    expect(card.destinationLinkTerms?.updatesLink).toBe(`https://canvas.octant.sh/s/${shareId}`);
    expect(decided.kind).toBe("exported");
    expect(h.service.calls.map((call) => call.kind)).toEqual(["create", "update"]);
    expect(h.service.calls[1]?.input.ownerSecret).toBe(ownerSecret);
    expect(h.links.list(canvasId).shares).toHaveLength(1);
  });

  it("revokes at the service with the owner secret, then forgets the secret", async () => {
    const h = harness();
    h.turnOn();
    await publish(h);
    const revoked = await h.links.revoke(canvasId, shareId);
    expect(revoked.kind).toBe("revoked");
    expect(h.service.calls.at(-1)).toMatchObject({
      kind: "revoke",
      input: { shareId, ownerSecret },
    });
    expect(h.secrets.held.size).toBe(0);
    expect(h.links.list(canvasId).shares[0]?.status).toBe("revoked");
  });

  it("keeps a revoke it could not deliver, and finishes it after a restart", async () => {
    const connection = openConnection();
    const service = fakeService();
    const secrets = memorySecrets();
    const first = harness({ connection, service, secrets });
    first.turnOn();
    await publish(first);
    service.answerRevokeWith({ kind: "unreachable" });
    const revoking = await first.links.revoke(canvasId, shareId);
    expect(revoking.kind).toBe("revoking");
    expect(first.links.list(canvasId).shares[0]?.status).toBe("revoking");

    service.answerRevokeWith({ kind: "refused", code: "gone", message: "Gone." });
    const second = harness({ connection, service, secrets });
    await second.links.retryPendingRevocations();
    expect(second.links.list(canvasId).shares[0]?.status).toBe("revoked");
    expect(secrets.held.size).toBe(0);
  });

  it("revokes a purged Canvas's links, and the owed revoke survives the Canvas", async () => {
    const connection = openConnection();
    const service = fakeService();
    const secrets = memorySecrets();
    const first = harness({ connection, service, secrets });
    first.turnOn();
    await publish(first);
    service.answerRevokeWith({ kind: "unreachable" });
    first.links.revokeForPurge([String(canvasId)]);
    first.links.forget([String(canvasId)]);
    await first.links.retryPendingRevocations();
    expect(service.calls.filter((call) => call.kind === "revoke")).not.toHaveLength(0);
    expect(secrets.held.size).toBe(1);

    service.answerRevokeWith({ kind: "ok", value: { shareId } });
    const restarted = harness({ connection, service, secrets });
    await restarted.links.retryPendingRevocations();
    expect(secrets.held.size).toBe(0);
  });

  it("refuses a stale settings change instead of overwriting another window's", () => {
    const h = harness();
    h.turnOn();
    const stale = h.links.changeSettings({
      schemaVersion: 1,
      kind: "set-canvas-public-link-settings",
      enabled: false,
      serviceUrl,
      expectedVersion: Schema.decodeUnknownSync(AggregateVersion)(0),
    });
    expect(stale).toMatchObject({
      kind: "canvas-public-link-settings-refused",
      reason: "stale-version",
    });
    expect(h.links.enabled()).toBe(true);
  });
});
