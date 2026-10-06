import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { decodeCanvasId, decodeCanvasVersionId, type CanvasBlock } from "@octant/contracts/canvas";
import {
  CANVAS_EXPORT_APPROVAL_TTL_MS,
  CANVAS_EXPORT_MAX_PENDING_PER_CANVAS,
  CanvasExportApprovalId,
  decodeCanvasExportContribution,
  decodeCanvasExportPrepareRequest,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import {
  EventActor,
  ReplayCursor,
  decodeUtcTimestamp,
  type EventEnvelope,
} from "@octant/contracts";
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import type { CanvasExportActivationFacts } from "@octant/plugin-host/canvas-export-contributions";
import type { ExtensionEffectiveState } from "@octant/contracts/extensions";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { CanvasExportEventStore, registerCanvasExportEvents } from "./canvasExportEventStore";
import {
  CanvasExportService,
  type CanvasExportDocument,
  type CanvasExportTargetBinding,
} from "./canvasExportService";
import { createCanvasExportFilePort } from "./canvasExportFilePort";
import {
  canvasExportTargetBindings,
  type CanvasExportTargetRegistration,
} from "./canvasExportTargets";
import { FOLDER_EXPORT_TARGET_ID } from "./folderExportTarget";
import { GIST_EXPORT_TARGET_ID, type GistExportAvailability } from "./gistExportTarget";
import type { GistCreationRequest, GistCreationResult } from "../github/gistCreationPort";

const directories: string[] = [];
const start = Date.parse("2026-08-01T21:00:00.000Z");
const now = new Date(start).toISOString();
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const versionId = decodeCanvasVersionId("22222222-2222-4222-8222-222222222222");
const decodeApprovalId = Schema.decodeUnknownSync(CanvasExportApprovalId);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

const localActor = decodeActor({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const remoteActor = decodeActor({
  kind: "remote-device",
  actorId: "16161616-1616-4161-8161-161616161616",
  deviceId: "16161616-1616-4161-8161-161616161616",
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-export-service-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A real folder on this machine for the folder destination to write into, and
 * the registration that offers it. Nobody else can read it, and it is never a
 * real person's folder.
 */
function exportFolder(options?: { readonly chosen?: boolean }): {
  readonly folder: string;
  readonly registration: CanvasExportTargetRegistration;
} {
  const folder = join(tmpdir(), `octant-export-${randomUUID()}`);
  mkdirSync(folder, { mode: 0o700 });
  directories.push(folder);
  const chosen = options?.chosen !== false;
  return {
    folder,
    registration: {
      folderFor: () => (chosen ? folder : undefined),
      files: createCanvasExportFilePort(),
      home: tmpdir(),
      standingOutsideApproval: false,
      newTempId: randomUUID,
    },
  };
}

function document(text = "Scope"): CanvasExportDocument {
  return {
    canvasId,
    versionId,
    sequence: 1,
    title: "Launch plan",
    blocks: [
      {
        blockId: "heading-1",
        schemaVersion: 1,
        kind: "heading",
        level: 1,
        text,
      },
    ] as unknown as ReadonlyArray<CanvasBlock>,
  };
}

/**
 * The folder registration plus a fake GitHub client, so a gist export runs
 * through the same service and journal a real one would.
 */
function gistRegistration(availability: GistExportAvailability): {
  readonly registration: CanvasExportTargetRegistration;
  readonly requests: GistCreationRequest[];
} {
  const requests: GistCreationRequest[] = [];
  return {
    requests,
    registration: {
      ...exportFolder().registration,
      gist: {
        availability: () => availability,
        gists: {
          create: async (input): Promise<GistCreationResult> => {
            requests.push(input);
            return {
              kind: "created",
              gist: {
                id: "aa11bb22cc33dd44",
                url: "https://gist.github.com/octocat/aa11bb22cc33dd44",
              },
            };
          },
        },
      },
    },
  };
}

interface FactOverrides {
  readonly installed?: boolean;
  readonly trusted?: boolean;
  readonly desiredEnabled?: boolean;
  readonly effectiveState?: ExtensionEffectiveState;
  readonly connected?: boolean;
}

function binding(
  targetId: string,
  calls: CanvasExportRenderedOutput[],
  facts?: FactOverrides,
): CanvasExportTargetBinding {
  const target: CanvasExportTarget = {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId,
      label: "Reading copy",
      formats: ["markdown", "html"],
    }),
    exportDocument: async (output) => {
      calls.push(output);
      return { kind: "receipt", receipt: { kind: "remote-id", remoteId: `copy-${targetId}` } };
    },
  };
  const activation: CanvasExportActivationFacts = {
    installed: true,
    trusted: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
    connected: true,
    ...facts,
  };
  return { facts: activation, target };
}

function harness(
  bindings?: () => ReadonlyArray<CanvasExportTargetBinding>,
  options?: { readonly doc?: CanvasExportDocument },
) {
  const calls: CanvasExportRenderedOutput[] = [];
  const held = bindings ?? (() => [binding("reading-copy", calls)]);
  let n = 0;
  const nextId = () => {
    n += 1;
    return `55555555-5555-4555-8555-${n.toString(16).padStart(12, "0")}`;
  };
  // A mutable clock: tests advance it to cross an approval's deadline.
  let clockMs = start;
  const connection = openConnection();
  const journal = new Journal({
    connection,
    registry: registerCanvasExportEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const eventStore = new CanvasExportEventStore({ journal, uuid: nextId });
  const service = new CanvasExportService({
    load: () => options?.doc ?? document(),
    targets: held,
    eventStore,
    uuid: nextId,
    clock: () => decodeUtcTimestamp(new Date(clockMs).toISOString()),
  });
  const envelopes = (): ReadonlyArray<EventEnvelope> =>
    journal.replay(decodeReplayCursor({ afterSequence: 0, limit: 100 }));
  return {
    calls,
    service,
    eventStore,
    envelopes,
    connection,
    advanceClock: (ms: number) => {
      clockMs += ms;
    },
  };
}

function prepareRequest(targetId = "reading-copy") {
  return decodeCanvasExportPrepareRequest({
    schemaVersion: 1,
    kind: "canvas-export-prepare",
    canvasId,
    versionId,
    expectedSequence: 1,
    targetId,
    format: "markdown",
  });
}

describe("canvas export service", () => {
  it("does not call a destination or journal an export without approval", async () => {
    const { calls, service, eventStore, connection } = harness();

    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    expect(calls).toHaveLength(0);
    expect(eventStore.replay()).toEqual([]);

    const missing = await service.decide({
      canvasId,
      approvalId: decodeApprovalId("44444444-4444-4444-8444-000000000099"),
      decision: "approved",
      permitted: true,
      actor: localActor,
    });
    expect(missing).toMatchObject({ kind: "refused", code: "approval-required" });
    expect(calls).toHaveLength(0);

    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    const denied = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "denied",
      permitted: true,
      actor: localActor,
    });
    expect(denied.kind).toBe("denied");
    expect(calls).toHaveLength(0);
    expect(eventStore.replay()).toEqual([]);
    connection.close();
  });

  it("calls the destination only after approval and journals the receipt under the local actor", async () => {
    const { calls, service, eventStore, envelopes, connection } = harness();
    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }

    const exported = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });

    expect(calls).toHaveLength(1);
    expect(exported.kind).toBe("exported");
    expect(eventStore.replay()[0]?.outcome).toEqual({
      kind: "receipt",
      receipt: { kind: "remote-id", remoteId: "copy-reading-copy" },
    });
    expect(envelopes()[0]?.actor.kind).toBe("local-user");
    connection.close();
  });

  it("journals a remote approval as that device, never as the local user", async () => {
    const { service, envelopes, connection } = harness();
    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    const exported = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: remoteActor,
    });
    expect(exported.kind).toBe("exported");
    expect(envelopes()[0]?.actor).toEqual(remoteActor);
    connection.close();
  });

  it("refuses a format this host does not render without calling the destination", () => {
    const { calls, service, connection } = harness();
    const refused = service.prepare(
      decodeCanvasExportPrepareRequest({
        schemaVersion: 1,
        kind: "canvas-export-prepare",
        canvasId,
        versionId,
        expectedSequence: 1,
        targetId: "reading-copy",
        format: "pdf",
      }),
      true,
    );

    expect(refused).toMatchObject({ kind: "refused", code: "unsupported-format" });
    expect(calls).toHaveLength(0);
    connection.close();
  });

  it("never offers or delivers an id declared by two bindings, whichever is admitted", async () => {
    const disabledCalls: CanvasExportRenderedOutput[] = [];
    const admittedCalls: CanvasExportRenderedOutput[] = [];
    const { service, connection } = harness(() => [
      binding("shared-target", disabledCalls, { trusted: false }),
      binding("shared-target", admittedCalls),
    ]);

    // The ambiguous id is absent from the offer list entirely.
    const offers = service.offers(canvasId);
    expect(offers?.targets.map((offer) => String(offer.targetId))).toEqual([]);

    // Preparing it is refused, so no card can name one while the other sends.
    const prepared = service.prepare(prepareRequest("shared-target"), true);
    expect(prepared).toMatchObject({ kind: "refused", code: "not-offered" });

    // A unique id beside the ambiguity is still offered and delivered.
    const both = harness(() => [
      binding("shared-target", disabledCalls, { trusted: false }),
      binding("shared-target", admittedCalls),
      binding("unique-target", admittedCalls),
    ]);
    expect(both.service.offers(canvasId)?.targets.map((offer) => String(offer.targetId))).toEqual([
      "unique-target",
    ]);
    const preparedUnique = both.service.prepare(prepareRequest("unique-target"), true);
    expect(preparedUnique.kind).toBe("approval");
    if (preparedUnique.kind === "approval") {
      const exported = await both.service.decide({
        canvasId,
        approvalId: preparedUnique.card.approvalId,
        decision: "approved",
        permitted: true,
        actor: localActor,
      });
      expect(exported.kind).toBe("exported");
      expect(disabledCalls).toHaveLength(0);
      expect(admittedCalls).toHaveLength(1);
    }
    both.connection.close();
    connection.close();
  });

  it("refuses an approval answered after its deadline and releases it", async () => {
    const { calls, service, connection, advanceClock } = harness();
    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    expect(prepared.card.expiresAt).toBe(
      new Date(start + CANVAS_EXPORT_APPROVAL_TTL_MS).toISOString(),
    );

    advanceClock(CANVAS_EXPORT_APPROVAL_TTL_MS);
    const expired = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });
    expect(expired).toMatchObject({ kind: "refused", code: "expired" });
    expect(calls).toHaveLength(0);

    // The entry is gone: a second answer is no longer an expiry, just unknown.
    const again = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });
    expect(again).toMatchObject({ kind: "refused", code: "approval-required" });
    connection.close();
  });

  it("evicts the oldest pending approval once the per-canvas bound is reached", async () => {
    const { calls, service, connection } = harness();
    const approvalIds: string[] = [];
    for (let index = 0; index < CANVAS_EXPORT_MAX_PENDING_PER_CANVAS; index += 1) {
      const prepared = service.prepare(prepareRequest(), true);
      expect(prepared.kind).toBe("approval");
      if (prepared.kind === "approval") {
        approvalIds.push(String(prepared.card.approvalId));
      }
    }
    const extra = service.prepare(prepareRequest(), true);
    expect(extra.kind).toBe("approval");

    // The oldest approval was evicted; answering it refuses, never delivers.
    const evicted = await service.decide({
      canvasId,
      approvalId: decodeApprovalId(approvalIds[0] ?? ""),
      decision: "approved",
      permitted: true,
      actor: localActor,
    });
    expect(evicted).toMatchObject({ kind: "refused", code: "expired" });
    expect(calls).toHaveLength(0);

    // The newest approval is still answerable.
    if (extra.kind === "approval") {
      const answered = await service.decide({
        canvasId,
        approvalId: extra.card.approvalId,
        decision: "approved",
        permitted: true,
        actor: localActor,
      });
      expect(answered.kind).toBe("exported");
    }
    connection.close();
  });

  it("answering the same approval twice delivers once and journals once", async () => {
    const { calls, service, eventStore, connection } = harness();
    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    const first = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });
    const second = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });
    expect(first.kind).toBe("exported");
    expect(second).toMatchObject({ kind: "refused", code: "approval-required" });
    expect(calls).toHaveLength(1);
    expect(eventStore.replay()).toHaveLength(1);
    connection.close();
  });

  it("reports a delivered export the journal could not record instead of failing it", async () => {
    const { calls, service, eventStore, connection } = harness();
    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    vi.spyOn(eventStore, "append").mockImplementation(() => {
      throw new Error("journal unavailable");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      kind: "unrecorded",
      outcome: {
        kind: "receipt",
        receipt: { kind: "remote-id", remoteId: "copy-reading-copy" },
      },
      message: "The export was delivered, but this host could not record it.",
    });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    connection.close();
  });

  it("measures the payload in UTF-8 bytes, not code units", () => {
    const { service, connection } = harness(undefined, { doc: document("Préparons 🚀 le Café") });
    const prepared = service.prepare(prepareRequest(), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    const payload = prepared.card.payload;
    const bytes = new TextEncoder().encode(payload).length;
    expect(prepared.card.byteLength).toBe(bytes);
    expect(bytes).toBeGreaterThan(payload.length);
    connection.close();
  });

  it("refuses an unauthorized decide without delivering", async () => {
    const { calls, service, connection } = harness();
    const prepared = service.prepare(prepareRequest(), true);
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    const refused = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: false,
      actor: remoteActor,
    });
    expect(refused).toMatchObject({ kind: "refused", code: "unauthorized" });
    expect(calls).toHaveLength(0);
    connection.close();
  });

  it("writes the exported file where the card named it, and journals the written path", async () => {
    const { folder, registration } = exportFolder();
    const { service, eventStore, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );

    const prepared = service.prepare(prepareRequest(FOLDER_EXPORT_TARGET_ID), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    expect(prepared.card.destinationLabel).toBe("A folder on this Mac");
    expect(prepared.card.destinationPath).toBe(join(folder, "Launch plan.md"));
    expect(prepared.card.replacesExisting).toBe(false);
    // Preparing shows the person the payload and the place; it writes neither.
    expect(readdirSync(folder)).toEqual([]);

    const exported = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });

    expect(exported.kind).toBe("exported");
    expect(readFileSync(join(folder, "Launch plan.md"), "utf8")).toBe(prepared.card.payload);
    expect(eventStore.replay()[0]?.outcome).toEqual({
      kind: "receipt",
      receipt: { kind: "path", path: join(folder, "Launch plan.md") },
    });
    connection.close();
  });

  it("asks before replacing a file that is already there, and then replaces it", async () => {
    const { folder, registration } = exportFolder();
    writeFileSync(join(folder, "Launch plan.md"), "what the person kept", "utf8");
    const { service, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );

    const prepared = service.prepare(prepareRequest(FOLDER_EXPORT_TARGET_ID), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    // The card names the file it is about to replace, so approving it is the
    // person's confirmation rather than a surprise.
    expect(prepared.card.destinationPath).toBe(join(folder, "Launch plan.md"));
    expect(prepared.card.replacesExisting).toBe(true);
    expect(readFileSync(join(folder, "Launch plan.md"), "utf8")).toBe("what the person kept");

    await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });

    expect(readFileSync(join(folder, "Launch plan.md"), "utf8")).toBe(prepared.card.payload);
    expect(readdirSync(folder)).toEqual(["Launch plan.md"]);
    connection.close();
  });

  it("writes nothing at all when the person declines", async () => {
    const { folder, registration } = exportFolder();
    const { service, eventStore, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );
    const prepared = service.prepare(prepareRequest(FOLDER_EXPORT_TARGET_ID), true);
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }

    const denied = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "denied",
      permitted: true,
      actor: localActor,
    });

    expect(denied.kind).toBe("denied");
    expect(readdirSync(folder)).toEqual([]);
    expect(eventStore.replay()).toEqual([]);
    connection.close();
  });

  it("offers the folder destination as not connected until a folder is chosen", () => {
    const { registration } = exportFolder({ chosen: false });
    const { service, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );

    const offer = service
      .offers(canvasId)
      ?.targets.find((candidate) => String(candidate.targetId) === FOLDER_EXPORT_TARGET_ID);

    expect(offer?.status).toBe("not-connected");
    expect(offer?.formats).toEqual(["markdown", "html"]);
    connection.close();
  });

  it("reports the folder destination refused once the folder has gone", () => {
    const { folder, registration } = exportFolder();
    const { service, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );
    rmSync(folder, { recursive: true, force: true });

    const offer = service
      .offers(canvasId)
      ?.targets.find((candidate) => String(candidate.targetId) === FOLDER_EXPORT_TARGET_ID);

    expect(offer?.status).toBe("refused");
    expect(offer?.message).toContain("could not be read");
    connection.close();
  });

  it("offers the gist destination as not connected until GitHub is connected", () => {
    const { registration } = gistRegistration({ kind: "not-connected" });
    const { service, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );

    const offer = service
      .offers(canvasId)
      ?.targets.find((candidate) => String(candidate.targetId) === GIST_EXPORT_TARGET_ID);

    expect(offer?.status).toBe("not-connected");
    expect(offer?.formats).toEqual(["markdown"]);
    connection.close();
  });

  it("shows the account, the audience, and the public note on the card, and posts nothing until approved", async () => {
    const { registration, requests } = gistRegistration({ kind: "ready", account: "octocat" });
    const { service, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );

    const prepared = service.prepare(prepareRequest(GIST_EXPORT_TARGET_ID), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }
    expect(prepared.card.destinationAccount).toBe("octocat");
    expect(prepared.card.destinationVisibility).toBe("secret");
    expect(prepared.card.destinationNote).toContain("visible to anyone");
    // The gist has no URL until it exists, so the card names no path.
    expect(prepared.card.destinationPath).toBeUndefined();
    expect(requests).toHaveLength(0);

    const exported = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });

    expect(exported.kind).toBe("exported");
    expect(requests).toHaveLength(1);
    connection.close();
  });

  it("posts a public gist when the person chose public on the card, and journals the URL", async () => {
    const { registration, requests } = gistRegistration({ kind: "ready", account: "octocat" });
    const { service, eventStore, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );
    const prepared = service.prepare(prepareRequest(GIST_EXPORT_TARGET_ID), true);
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }

    await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
      visibility: "public",
    });

    expect(requests[0]?.visibility).toBe("public");
    expect(eventStore.replay()[0]?.outcome).toEqual({
      kind: "receipt",
      receipt: {
        kind: "link",
        href: "https://gist.github.com/octocat/aa11bb22cc33dd44",
        remoteId: "aa11bb22cc33dd44",
      },
    });
    connection.close();
  });

  it("does not pass a client's audience choice to a destination that offered none", async () => {
    // A destination that describes nothing — no path, no account, no audience —
    // is the shape a third-party target with no card facts has. The route
    // forwards whatever visibility the client sent, so the service is what must
    // keep that choice from arriving as a confirmed audience.
    const seen: Array<{ readonly path?: string; readonly visibility?: string }> = [];
    const silent: CanvasExportTargetBinding = {
      facts: {
        installed: true,
        trusted: true,
        desiredEnabled: true,
        effectiveState: { kind: "effective" },
        connected: true,
      },
      target: {
        contribution: decodeCanvasExportContribution({
          schemaVersion: 1,
          kind: "canvas-export-contribution",
          targetId: "silent-destination",
          label: "Silent destination",
          formats: ["markdown"],
        }),
        exportDocument: async (output, confirmed) => {
          seen.push({ ...(confirmed === undefined ? {} : confirmed) });
          return { kind: "receipt", receipt: { kind: "remote-id", remoteId: "copy-1" } };
        },
      },
    };
    const { service, connection } = harness(() => [silent]);
    const prepared = service.prepare(prepareRequest("silent-destination"), true);
    expect(prepared.kind).toBe("approval");
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }

    const exported = await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
      visibility: "public",
    });

    expect(exported.kind).toBe("exported");
    expect(seen).toEqual([{}]);
    connection.close();
  });

  it("keeps the destination's own audience when no choice arrives", async () => {
    // The gist card offered an audience, so its destination hears the choice
    // only as a change to that audience — and with no choice at all, the
    // description the card showed stands.
    const { registration, requests } = gistRegistration({ kind: "ready", account: "octocat" });
    const { service, connection } = harness(() =>
      canvasExportTargetBindings(registration, canvasId),
    );
    const prepared = service.prepare(prepareRequest(GIST_EXPORT_TARGET_ID), true);
    if (prepared.kind !== "approval") {
      connection.close();
      return;
    }

    await service.decide({
      canvasId,
      approvalId: prepared.card.approvalId,
      decision: "approved",
      permitted: true,
      actor: localActor,
    });

    expect(requests[0]?.visibility).toBe("secret");
    connection.close();
  });
});
