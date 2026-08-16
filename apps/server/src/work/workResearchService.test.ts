import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { WorkResearchEventStore } from "./workResearchEventStore";
import { WorkResearchProjection } from "./workResearchProjection";
import {
  WorkResearchService,
  type WorkResearchExcerptVerification,
  type WorkResearchSourcePort,
} from "./workResearchService";
import { classifyExcerptSupport } from "@octant/domain";
import {
  decodeWorkResearchBriefId,
  decodeWorkResearchCommand,
  decodeWorkResearchReportId,
  decodeWorkResearchRequestId,
  decodeWorkSourceId,
  decodePreviewSourceVersion,
  type WorkResearchCommand,
  type WorkResearchCommandResult,
  type PreviewSourceVersion,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";

const directories: Array<string> = [];
const now = "2026-07-24T08:00:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-work-research-store-"));
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

const ids = {
  brief: decodeWorkResearchBriefId("11111111-1111-4111-8111-111111111111"),
  source: decodeWorkSourceId("22222222-2222-4222-8222-222222222222"),
  source2: decodeWorkSourceId("33333333-3333-4333-8333-333333333333"),
  report: decodeWorkResearchReportId("44444444-4444-4444-8444-444444444444"),
  request: decodeWorkResearchRequestId("55555555-5555-4555-8555-555555555555"),
  project: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
  evidence: "88888888-8888-4888-8888-888888888888",
  claim: "99999999-9999-4999-8999-999999999999",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
const changedSha = "1111111111111111111111111111111111111111111111111111111111111111";
const sourceVersion: PreviewSourceVersion = decodePreviewSourceVersion({
  contentSha256: sha256,
  byteSize: 256,
  observedAt: now,
});
const changedVersion: PreviewSourceVersion = decodePreviewSourceVersion({
  contentSha256: changedSha,
  byteSize: 300,
  observedAt: now,
});

const sourcePolicy = {
  allowedKinds: ["web", "file", "user-reference", "mail-export"],
  maxSources: 8,
  excerptByteBudget: 64_000,
} as const;

interface StoreFixture {
  readonly service: WorkResearchService;
  readonly projection: WorkResearchProjection;
  readonly eventStore: WorkResearchEventStore;
  readonly sourcePort: FakeSourcePort;
  readonly uuid: () => string;
  readonly connection: SqliteConnection;
}

/**
 * The confined source the fixture's `file` source stands for. The recorded
 * excerpt spans a line break here, so a genuine excerpt is still recognized
 * after the port's whitespace normalization.
 */
const sourceText = [
  "# Local-first notes",
  "",
  "Local-first software owns user data",
  "and prioritizes offline agency.",
  "",
  "Sync is a means, not the product.",
].join("\n");

class FakeSourcePort implements WorkResearchSourcePort {
  readonly observations = new Map<string, PreviewSourceVersion | undefined>();
  /** Decoded source text, or `undefined` for a source this host cannot decode. */
  readonly texts = new Map<string, string | undefined>();
  private throwNext = false;

  setObservation(sourceRef: string, version: PreviewSourceVersion | undefined): void {
    this.observations.set(sourceRef, version);
  }

  setText(sourceRef: string, text: string | undefined): void {
    this.texts.set(sourceRef, text);
  }

  throwOnNextObserve(): void {
    this.throwNext = true;
  }

  async observeSourceVersion(input: {
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly sourceVersion: PreviewSourceVersion } | undefined> {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("source port unavailable");
    }
    if (input.signal?.aborted) throw new Error("aborted");
    const version = this.observations.get(input.sourceRef);
    if (version === undefined) return undefined;
    return { sourceVersion: version };
  }

  async verifySourceExcerpt(input: {
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly excerpt: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkResearchExcerptVerification> {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("source port unavailable");
    }
    if (input.signal?.aborted) throw new Error("aborted");
    const sourceVersion = this.observations.get(input.sourceRef);
    const text = this.texts.get(input.sourceRef);
    // A source this host cannot re-read or cannot decode as text supports no
    // excerpt at all, exactly like the real port.
    if (sourceVersion === undefined || text === undefined) return { outcome: "unverifiable" };
    const support = classifyExcerptSupport({ sourceText: text, excerpt: input.excerpt });
    return support === "present"
      ? { outcome: "excerpt-present", sourceVersion }
      : { outcome: "excerpt-absent", sourceVersion };
  }
}

function createFixture(): StoreFixture {
  const connection = openConnection();
  const registry = new EventRegistry().register("work.research-recorded@1", 1, Schema.Unknown);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
  };
  const eventStore = new WorkResearchEventStore({ journal, uuid, actor });
  const projection = new WorkResearchProjection();
  const sourcePort = new FakeSourcePort();
  sourcePort.setText("opaque-source-token-1", sourceText);
  sourcePort.setText("opaque-source-token-2", sourceText);
  const service = new WorkResearchService({
    projection,
    eventStore,
    sources: sourcePort,
    actor,
    clock: () => now,
  });
  return { service, projection, eventStore, sourcePort, uuid, connection };
}

type LooseOverrides = Record<string, unknown>;

function createBriefCommand(overrides: LooseOverrides = {}): WorkResearchCommand {
  return decodeWorkResearchCommand({
    kind: "create-brief",
    requestId: ids.request,
    projectId: ids.project,
    briefId: ids.brief,
    questions: ["What are the tradeoffs of local-first AI workspaces?"],
    sourcePolicy,
    deliverables: ["report"],
    ...overrides,
  });
}

function addSourceCommand(overrides: LooseOverrides = {}): WorkResearchCommand {
  return decodeWorkResearchCommand({
    kind: "add-source",
    requestId: ids.request,
    projectId: ids.project,
    briefId: ids.brief,
    expectedVersion: 1,
    sourceId: ids.source,
    sourceKind: "web",
    sourceRef: "opaque-source-token-1",
    displayName: "Local-first essay",
    excerpt: "Local-first software owns user data and prioritizes offline agency.",
    citationAnchor: "anchor-1",
    sourceVersion,
    ...overrides,
  });
}

function recordEvidenceCommand(overrides: LooseOverrides = {}): WorkResearchCommand {
  return decodeWorkResearchCommand({
    kind: "record-evidence",
    requestId: ids.request,
    projectId: ids.project,
    briefId: ids.brief,
    expectedVersion: 2,
    evidenceId: ids.evidence,
    sourceId: ids.source,
    citationAnchor: "anchor-1",
    excerpt: "Local-first software owns user data and prioritizes offline agency.",
    retrievedAt: now,
    ...overrides,
  });
}

function recordClaimCommand(overrides: LooseOverrides = {}): WorkResearchCommand {
  return decodeWorkResearchCommand({
    kind: "record-claim",
    requestId: ids.request,
    projectId: ids.project,
    briefId: ids.brief,
    expectedVersion: 3,
    claimId: ids.claim,
    text: "Local-first workspaces trade cloud sync convenience for user sovereignty.",
    citationAnchors: ["anchor-1"],
    ...overrides,
  });
}

function finalizeReportCommand(overrides: LooseOverrides = {}): WorkResearchCommand {
  return decodeWorkResearchCommand({
    kind: "finalize-report",
    requestId: ids.request,
    projectId: ids.project,
    briefId: ids.brief,
    expectedVersion: 4,
    reportId: ids.report,
    producedArtifactRef: "opaque-report-artifact-1",
    ...overrides,
  });
}

function revokeSourceCommand(overrides: LooseOverrides = {}): WorkResearchCommand {
  return decodeWorkResearchCommand({
    kind: "revoke-source",
    requestId: ids.request,
    projectId: ids.project,
    briefId: ids.brief,
    expectedVersion: 2,
    sourceId: ids.source,
    ...overrides,
  });
}

function cancelRetrievalCommand(overrides: LooseOverrides = {}): WorkResearchCommand {
  return decodeWorkResearchCommand({
    kind: "cancel-retrieval",
    requestId: ids.request,
    projectId: ids.project,
    briefId: ids.brief,
    expectedVersion: 2,
    sourceId: ids.source,
    ...overrides,
  });
}

const foreignProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function journaledFrameCount(eventStore: WorkResearchEventStore): number {
  const replay = eventStore.replayAll();
  if (replay.status !== "ok") throw new Error("unexpected snapshot-required replay");
  return replay.frames.length;
}

describe("WorkResearchService", () => {
  it("creates a draft brief and projects it", async () => {
    const { service, projection } = createFixture();
    const result = await service.execute(createBriefCommand());
    expect(result.kind).toBe("brief-created");
    const entry = projection.lookup(ids.brief);
    expect(entry?.brief.status).toBe("draft");
    expect(entry?.brief.version).toBe(1);
  });

  it("rejects a source command from a different Project before observing the source", async () => {
    const { service, projection, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);

    const result = await service.execute(addSourceCommand({ projectId: foreignProject }));

    // Reported exactly like an unknown brief so a window authorized for a
    // different Project cannot confirm the brief exists.
    expect(result.kind).toBe("not-found");
    expect(projection.lookup(ids.brief)?.brief.version).toBe(1);
  });

  it("rejects creating a duplicate brief as conflict", async () => {
    const { service } = createFixture();
    await service.execute(createBriefCommand());
    const result = await service.execute(createBriefCommand());
    expect(result.kind).toBe("conflict");
  });

  it("adds a fresh source and moves the brief to gathering", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    const result = await service.execute(addSourceCommand());
    expect(result.kind).toBe("source-added");
    if (result.kind !== "source-added") return;
    expect(result.brief.status).toBe("gathering");
    expect(result.brief.version).toBe(2);
    expect(result.source.availability).toBe("fresh");
  });

  it("rejects a duplicate source as conflict", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    const result = await service.execute(
      addSourceCommand({ sourceId: ids.source2, expectedVersion: 2 }),
    );
    expect(result.kind).toBe("conflict");
  });

  it("rejects a stale source as stale", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", changedVersion);
    const result = await service.execute(addSourceCommand());
    expect(result.kind).toBe("stale");
  });

  it("rejects an unavailable source as unsupported", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", undefined);
    const result = await service.execute(addSourceCommand());
    expect(result.kind).toBe("unsupported");
  });

  it("rejects a source kind outside the brief policy as unsupported", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(
      createBriefCommand({ sourcePolicy: { ...sourcePolicy, allowedKinds: ["file"] } }),
    );
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    const result = await service.execute(addSourceCommand({ sourceKind: "web" }));
    expect(result.kind).toBe("unsupported");
  });

  it("rejects adding a source when the budget is exceeded as conflict", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand({ sourcePolicy: { ...sourcePolicy, maxSources: 1 } }));
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    sourcePort.setObservation("opaque-source-token-2", sourceVersion);
    const result = await service.execute(
      addSourceCommand({
        sourceId: ids.source2,
        sourceRef: "opaque-source-token-2",
        expectedVersion: 2,
      }),
    );
    expect(result.kind).toBe("conflict");
  });

  it("fails closed as interrupted when the source port throws", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.throwOnNextObserve();
    const result = await service.execute(addSourceCommand());
    expect(result.kind).toBe("interrupted");
    if (result.kind !== "interrupted") return;
    expect(result.canRetry).toBe(true);
  });

  it("fails closed as interrupted when an abort signal fires", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    const controller = new AbortController();
    controller.abort();
    const result = await service.execute(addSourceCommand(), { signal: controller.signal });
    expect(result.kind).toBe("interrupted");
  });

  it("revokes a source and marks it revoked in the projection", async () => {
    const { service, sourcePort, projection } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    const result = await service.execute(revokeSourceCommand());
    expect(result.kind).toBe("source-revoked");
    const entry = projection.lookup(ids.brief);
    expect(entry?.revokedSourceIds.has(ids.source)).toBe(true);
    expect(entry?.sources.get(ids.source)?.availability).toBe("revoked");
  });

  it("reports a claim unsupported once the only source backing it is revoked", async () => {
    const { service, sourcePort, projection } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    await service.execute(recordClaimCommand());
    expect(projection.lookup(ids.brief)?.claims[0]?.unsupported).toBe(false);

    const revoked = await service.execute(revokeSourceCommand({ expectedVersion: 4 }));

    expect(revoked.kind).toBe("source-revoked");
    // The claim's only citation now resolves to a revoked source, so the
    // projection must stop presenting it as cited.
    expect(projection.lookup(ids.brief)?.claims[0]?.unsupported).toBe(true);

    // A report finalized after the revocation carries the same honest
    // support, so the deliverable never states provenance the brief lost.
    const finalized = await service.execute(finalizeReportCommand({ expectedVersion: 5 }));
    expect(finalized.kind).toBe("report-finalized");
    expect(projection.lookup(ids.brief)?.report?.claims[0]?.unsupported).toBe(true);
  });

  it("keeps a claim supported when the revoked source is not the one it cites", async () => {
    const { service, sourcePort, projection } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    sourcePort.setObservation("opaque-source-token-2", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(
      addSourceCommand({
        expectedVersion: 2,
        sourceId: ids.source2,
        sourceRef: "opaque-source-token-2",
        citationAnchor: "anchor-2",
      }),
    );
    await service.execute(recordEvidenceCommand({ expectedVersion: 3 }));
    await service.execute(
      recordEvidenceCommand({
        expectedVersion: 4,
        evidenceId: "88888888-8888-4888-8888-888888888889",
        sourceId: ids.source2,
        citationAnchor: "anchor-2",
      }),
    );
    await service.execute(
      recordClaimCommand({ expectedVersion: 5, citationAnchors: ["anchor-2"] }),
    );

    const revoked = await service.execute(
      revokeSourceCommand({ expectedVersion: 6, sourceId: ids.source }),
    );

    expect(revoked.kind).toBe("source-revoked");
    expect(projection.lookup(ids.brief)?.claims[0]?.unsupported).toBe(false);
  });

  it("records evidence whose excerpt occurs in the fresh source", async () => {
    const { service, sourcePort, projection } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    // The excerpt spans a line break in the source; only run-of-whitespace
    // differences are normalized away, so this is genuine source text.
    const result = await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    expect(result.kind).toBe("evidence-recorded");
    expect(projection.lookup(ids.brief)?.evidence.length).toBe(1);
  });

  it("refuses evidence whose excerpt never occurs in the source, journaling nothing", async () => {
    const { service, sourcePort, projection, eventStore } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    const framesBefore = journaledFrameCount(eventStore);

    // Plausible, unleaked, correctly anchored — and absent from the file.
    const result = await service.execute(
      recordEvidenceCommand({
        expectedVersion: 2,
        excerpt: "Local-first software eliminates every cloud outage.",
      }),
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.reason).toBe("invalid");
    expect(result.message).toContain("not found in the source");
    expect(journaledFrameCount(eventStore)).toBe(framesBefore);
    expect(projection.lookup(ids.brief)?.evidence.length).toBe(0);
  });

  it("refuses evidence when the source cannot be decoded as text", async () => {
    const { service, sourcePort, projection, eventStore } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    // A binary or otherwise undecodable source can support no excerpt check.
    sourcePort.setText("opaque-source-token-1", undefined);
    const framesBefore = journaledFrameCount(eventStore);

    const result = await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));

    expect(result.kind).toBe("unsupported");
    expect(journaledFrameCount(eventStore)).toBe(framesBefore);
    expect(projection.lookup(ids.brief)?.evidence.length).toBe(0);
  });

  it("rejects evidence on a revoked source as unauthorized", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(revokeSourceCommand());
    const result = await service.execute(recordEvidenceCommand({ expectedVersion: 3 }));
    expect(result.kind).toBe("unauthorized");
  });

  it("rejects evidence carrying a leaked credential as unauthorized", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    const result = await service.execute(
      recordEvidenceCommand({
        expectedVersion: 2,
        excerpt: "The token is sk-abcdef0123456789abcdef0123456789 in the config.",
      }),
    );
    expect(result.kind).toBe("unauthorized");
  });

  it("records a supported claim whose anchors resolve to fresh evidence", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    const result = await service.execute(recordClaimCommand({ expectedVersion: 3 }));
    expect(result.kind).toBe("claim-recorded");
    if (result.kind !== "claim-recorded") return;
    expect(result.claim.unsupported).toBe(false);
  });

  it("flags a claim with a dangling anchor as unsupported (citation integrity)", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    const result = await service.execute(
      recordClaimCommand({
        expectedVersion: 3,
        citationAnchors: ["anchor-missing"],
      }),
    );
    expect(result.kind).toBe("claim-recorded");
    if (result.kind !== "claim-recorded") return;
    expect(result.claim.unsupported).toBe(true);
  });

  it("flags a claim with no anchors as unsupported", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    const result = await service.execute(
      recordClaimCommand({ expectedVersion: 3, citationAnchors: [] }),
    );
    if (result.kind !== "claim-recorded") return;
    expect(result.claim.unsupported).toBe(true);
  });

  it("finalizes a report carrying evidence and claims", async () => {
    const { service, sourcePort, projection } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    await service.execute(recordClaimCommand({ expectedVersion: 3 }));
    const result = await service.execute(finalizeReportCommand({ expectedVersion: 4 }));
    expect(result.kind).toBe("report-finalized");
    if (result.kind !== "report-finalized") return;
    expect(result.report.evidence.length).toBe(1);
    expect(result.report.claims.length).toBe(1);
    expect(result.brief.status).toBe("finalized");
    expect(projection.lookup(ids.brief)?.report?.reportId).toBe(ids.report);
  });

  it("rejects transitions on a finalized brief as unauthorized", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    await service.execute(recordClaimCommand({ expectedVersion: 3 }));
    await service.execute(finalizeReportCommand({ expectedVersion: 4 }));
    const result = await service.execute(
      addSourceCommand({
        sourceId: ids.source2,
        sourceRef: "opaque-source-token-2",
        expectedVersion: 5,
      }),
    );
    expect(result.kind).toBe("unauthorized");
  });

  it("rebuilds the projection from the journal after a simulated restart", async () => {
    const fixture = createFixture();
    await fixture.service.execute(createBriefCommand());
    fixture.sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await fixture.service.execute(addSourceCommand());
    await fixture.service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    await fixture.service.execute(recordClaimCommand({ expectedVersion: 3 }));
    await fixture.service.execute(finalizeReportCommand({ expectedVersion: 4 }));

    // Simulate restart: fresh projection + event store over the same journal.
    const restartedProjection = new WorkResearchProjection();
    const registry = new EventRegistry().register("work.research-recorded@1", 1, Schema.Unknown);
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = new Journal({
      connection: fixture.connection,
      registry,
      projections,
      clock: () => now,
    });
    const restartedStore = new WorkResearchEventStore({
      journal,
      uuid: fixture.uuid,
      actor,
    });
    const restartedService = new WorkResearchService({
      projection: restartedProjection,
      eventStore: restartedStore,
      sources: new FakeSourcePort(),
      actor,
      clock: () => now,
    });
    const hydrate = restartedService.hydrate();
    expect(hydrate.status).toBe("ok");
    const entry = restartedProjection.lookup(ids.brief);
    expect(entry?.brief.status).toBe("finalized");
    expect(entry?.brief.version).toBe(5);
    expect(entry?.sources.size).toBe(1);
    expect(entry?.evidence.length).toBe(1);
    expect(entry?.claims.length).toBe(1);
    expect(entry?.report?.reportId).toBe(ids.report);
  });

  it("rejects an optimistic-concurrency mismatch as stale", async () => {
    const { service, sourcePort } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    const result = await service.execute(addSourceCommand({ expectedVersion: 99 }));
    expect(result.kind).toBe("stale");
  });

  describe("cross-Project brief mutations fail closed as not-found", () => {
    /**
     * A window authorized for Project A must not mutate — or confirm the
     * existence of — a brief stored under Project B. Each mutating command
     * kind carries Project A's id against Project B's brief and must be
     * rejected exactly like an unknown brief, with nothing journaled.
     */
    async function fixtureWithFreshSource() {
      const fixture = createFixture();
      await fixture.service.execute(createBriefCommand());
      fixture.sourcePort.setObservation("opaque-source-token-1", sourceVersion);
      await fixture.service.execute(addSourceCommand());
      return fixture;
    }

    function expectUntouched(fixture: StoreFixture, framesBefore: number): void {
      expect(journaledFrameCount(fixture.eventStore)).toBe(framesBefore);
      expect(fixture.projection.lookup(ids.brief)?.brief.version).toBe(2);
    }

    it("rejects revoke-source from a different Project", async () => {
      const fixture = await fixtureWithFreshSource();
      const framesBefore = journaledFrameCount(fixture.eventStore);
      const result = await fixture.service.execute(
        revokeSourceCommand({ projectId: foreignProject }),
      );
      expect(result.kind).toBe("not-found");
      expectUntouched(fixture, framesBefore);
    });

    it("rejects record-evidence from a different Project", async () => {
      const fixture = await fixtureWithFreshSource();
      const framesBefore = journaledFrameCount(fixture.eventStore);
      const result = await fixture.service.execute(
        recordEvidenceCommand({ projectId: foreignProject, expectedVersion: 2 }),
      );
      expect(result.kind).toBe("not-found");
      expectUntouched(fixture, framesBefore);
      expect(fixture.projection.lookup(ids.brief)?.evidence.length).toBe(0);
    });

    it("rejects record-claim from a different Project", async () => {
      const fixture = await fixtureWithFreshSource();
      const framesBefore = journaledFrameCount(fixture.eventStore);
      const result = await fixture.service.execute(
        recordClaimCommand({ projectId: foreignProject, expectedVersion: 2 }),
      );
      expect(result.kind).toBe("not-found");
      expectUntouched(fixture, framesBefore);
    });

    it("rejects finalize-report from a different Project", async () => {
      const fixture = await fixtureWithFreshSource();
      const framesBefore = journaledFrameCount(fixture.eventStore);
      const result = await fixture.service.execute(
        finalizeReportCommand({ projectId: foreignProject, expectedVersion: 2 }),
      );
      expect(result.kind).toBe("not-found");
      expectUntouched(fixture, framesBefore);
      expect(fixture.projection.lookup(ids.brief)?.brief.status).toBe("gathering");
    });

    it("rejects cancel-retrieval from a different Project", async () => {
      const fixture = await fixtureWithFreshSource();
      const framesBefore = journaledFrameCount(fixture.eventStore);
      const result = await fixture.service.execute(
        cancelRetrievalCommand({ projectId: foreignProject }),
      );
      expect(result.kind).toBe("not-found");
      expectUntouched(fixture, framesBefore);
    });
  });

  it("rejects evidence when the source changed since capture, journaling nothing", async () => {
    const { service, sourcePort, projection, eventStore } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    // The file changed after add-source: the projection still says fresh but
    // a re-observation now reports a different source version.
    sourcePort.setObservation("opaque-source-token-1", changedVersion);
    const framesBefore = journaledFrameCount(eventStore);
    const result = await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    expect(result.kind).toBe("stale");
    expect(journaledFrameCount(eventStore)).toBe(framesBefore);
    expect(projection.lookup(ids.brief)?.evidence.length).toBe(0);
  });

  it("rejects evidence when the source was deleted since capture, journaling nothing", async () => {
    const { service, sourcePort, projection, eventStore } = createFixture();
    await service.execute(createBriefCommand());
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    await service.execute(addSourceCommand());
    // The file was deleted after add-source: re-observation returns nothing.
    sourcePort.setObservation("opaque-source-token-1", undefined);
    const framesBefore = journaledFrameCount(eventStore);
    const result = await service.execute(recordEvidenceCommand({ expectedVersion: 2 }));
    expect(result.kind).toBe("unsupported");
    expect(journaledFrameCount(eventStore)).toBe(framesBefore);
    expect(projection.lookup(ids.brief)?.evidence.length).toBe(0);
  });

  it("returns a typed result for every command kind (no raw exceptions)", async () => {
    const { service, sourcePort } = createFixture();
    const results: Array<WorkResearchCommandResult> = [];
    results.push(await service.execute(createBriefCommand()));
    sourcePort.setObservation("opaque-source-token-1", sourceVersion);
    results.push(await service.execute(addSourceCommand()));
    results.push(await service.execute(cancelRetrievalCommand()));
    for (const result of results) {
      expect(typeof result.kind).toBe("string");
    }
  });
});
