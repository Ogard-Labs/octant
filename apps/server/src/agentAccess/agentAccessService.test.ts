import { generateKeyPairSync, randomUUID, sign, createHash, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_CONNECTION_CODE_PREFIX,
  DEFAULT_AGENT_GRANT_LIMITS,
  decodeAgentConnectionCode,
  type AgentAccessResult,
  type AgentGrantScope,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { agentProofPayload } from "@octant/domain";
import { AGENT_ACCESS_LOCAL_ACTOR, AgentAccessService } from "./agentAccessService";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const codeProject = "20000000-0000-4000-8000-000000000001";
const hostId = "30000000-0000-4000-8000-000000000001";
const origin = "https://192.168.1.20:8443";
const pin = `sha256-${"A".repeat(43)}`;

function harness(options: { readonly listenerOn?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-agent-access-"));
  directories.push(directory);
  const clock = { now: Date.parse("2026-11-11T10:00:00.000Z") };
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => new Date(clock.now).toISOString());
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date(clock.now).toISOString(),
  });
  const service = new AgentAccessService({
    connection,
    journal,
    uuid: randomUUID,
    now: () => clock.now,
    listener: () => (options.listenerOn === false ? undefined : { origin, pin, hostId }),
    projectType: (id) => (id === codeProject ? "code" : undefined),
  });
  return { service, clock };
}

function scope(overrides: Partial<AgentGrantScope> = {}): AgentGrantScope {
  return {
    projects: [codeProject as AgentGrantScope["projects"][number]],
    modes: ["code"],
    highestLevel: "ask-first",
    threads: "own",
    tools: ["start_work", "read_thread"],
    limits: DEFAULT_AGENT_GRANT_LIMITS,
    direct: false,
    ...overrides,
  };
}

function created(result: AgentAccessResult): string {
  if (result.kind !== "grant") throw new Error(`expected a grant, got ${result.kind}`);
  return String(result.grant.grant.grantId);
}

function enroll(service: AgentAccessService, grantId: string) {
  const ticket = service.execute(
    { kind: "issue-ticket", grantId: grantId as never },
    AGENT_ACCESS_LOCAL_ACTOR,
  );
  if (ticket.kind !== "ticket") throw new Error(`expected a ticket, got ${ticket.kind}`);
  const code = decodeAgentConnectionCode(
    JSON.parse(
      Buffer.from(
        ticket.connectionCode.slice(AGENT_CONNECTION_CODE_PREFIX.length),
        "base64url",
      ).toString(),
    ),
  );
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
  const fingerprint = createHash("sha256")
    .update(pair.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  return { code, pair, publicKey, fingerprint };
}

function proof(input: {
  readonly grantId: string;
  readonly fingerprint: string;
  readonly privateKey: KeyObject;
  readonly at: number;
  readonly nonce: string;
  readonly body: Uint8Array;
}): string {
  const payload = agentProofPayload({
    method: "POST",
    pathWithQuery: "/api/agent-access/mcp",
    bodyDigest: createHash("sha256").update(input.body).digest("hex"),
    timestamp: String(input.at),
    nonce: input.nonce,
    hostId,
    grantId: input.grantId,
    fingerprint: input.fingerprint,
  });
  const signature = sign("sha256", Buffer.from(payload), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `v1.${input.grantId}.${input.fingerprint}.${input.at}.${input.nonce}.${signature}`;
}

describe("agent grants", () => {
  it("enrolls a bridge key only after the person confirms it, then accepts its signed requests once each", () => {
    const { service, clock } = harness();
    const grantId = created(
      service.execute(
        { kind: "create", draft: { name: "Home bot", scope: scope(), days: 30 } },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    );
    const { code, pair, publicKey, fingerprint } = enroll(service, grantId);
    expect(code).toMatchObject({ origin, hostId, grantId, pin });

    const body = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    const request = (nonce: string) => ({
      method: "POST",
      pathWithQuery: "/api/agent-access/mcp",
      body,
      proof: proof({
        grantId,
        fingerprint,
        privateKey: pair.privateKey,
        at: clock.now,
        nonce,
        body,
      }),
      authorization: null,
      sourceClass: "tailscale" as const,
    });

    expect(
      service.claim({
        ticketId: code.ticketId,
        ticketProof: code.ticketProof,
        publicKey,
        fingerprint,
        label: "home-server",
      }),
    ).toEqual({ kind: "pending", grantId });
    // A claimed but unconfirmed key proves nothing yet.
    expect(service.authenticate(request("nonce-aaaaaaaaaaaa1")).kind).toBe("unauthorized");

    expect(
      service.execute(
        { kind: "confirm-key", grantId: grantId as never, fingerprint },
        AGENT_ACCESS_LOCAL_ACTOR,
      ).kind,
    ).toBe("grant");
    expect(service.authenticate(request("nonce-aaaaaaaaaaaa2")).kind).toBe("authenticated");
    // The same signed request again is a replay.
    expect(service.authenticate(request("nonce-aaaaaaaaaaaa2")).kind).toBe("unauthorized");
    // A ticket is single-use.
    expect(
      service.claim({
        ticketId: code.ticketId,
        ticketProof: code.ticketProof,
        publicKey,
        fingerprint,
        label: "again",
      }),
    ).toEqual({ kind: "refused" });
  });

  it("lets an unconfirmed claim lapse with its connection code", () => {
    const { service, clock } = harness();
    const grantId = created(
      service.execute(
        { kind: "create", draft: { name: "Home bot", scope: scope(), days: 30 } },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    );
    const { code, publicKey, fingerprint } = enroll(service, grantId);
    expect(
      service.claim({
        ticketId: code.ticketId,
        ticketProof: code.ticketProof,
        publicKey,
        fingerprint,
        label: "laptop",
      }).kind,
    ).toBe("pending");
    expect(service.list()[0]?.pendingClaims).toHaveLength(1);

    clock.now += 6 * 60 * 1_000;
    expect(service.list()[0]?.pendingClaims).toEqual([]);
    expect(
      service.execute(
        { kind: "confirm-key", grantId: grantId as never, fingerprint },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    ).toMatchObject({ kind: "refused", reason: "not-pending" });
    expect(service.read(grantId)?.keys).toEqual([]);
  });

  it("ends the agent's sessions and refuses its key the moment the grant is revoked", () => {
    const { service, clock } = harness();
    const grantId = created(
      service.execute(
        { kind: "create", draft: { name: "Bot", scope: scope({ direct: true }), days: 30 } },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    );
    const key = service.execute(
      { kind: "rotate-direct-key", grantId: grantId as never },
      AGENT_ACCESS_LOCAL_ACTOR,
    );
    if (key.kind !== "direct-key") throw new Error(key.kind);
    expect(key.endpoint).toBe(`${origin}/api/agent-access/mcp`);
    const bearer = {
      method: "POST",
      pathWithQuery: "/api/agent-access/mcp",
      body: new Uint8Array(),
      proof: null,
      authorization: `Bearer ${key.key}`,
      sourceClass: "lan-private" as const,
    };
    const first = service.authenticate(bearer);
    if (first.kind !== "authenticated") throw new Error(first.kind);
    expect(first.credential).toBe("direct");
    // Changes the key's last character, whatever it is; replacing it with a
    // fixed "A" left the key unchanged whenever it already ended in one.
    const wrongKey = `${key.key.slice(0, -1)}${key.key.endsWith("A") ? "B" : "A"}`;
    expect(service.authenticate({ ...bearer, authorization: `Bearer ${wrongKey}` }).kind).toBe(
      "unauthorized",
    );

    clock.now += 1_000;
    expect(
      service.execute(
        { kind: "revoke", grantId: grantId as never, stopRunningTurns: false },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    ).toEqual({ kind: "done" });
    expect(first.signal.aborted).toBe(true);
    expect(service.authenticate(bearer).kind).toBe("unauthorized");
    expect(service.read(grantId)?.state).toBe("revoked");
  });

  it("holds a grant's turn starts until each is released, once", () => {
    const { service } = harness();
    const first = service.holdTurnStart("g");
    const second = service.holdTurnStart("g");
    expect([first.startingAlready, second.startingAlready]).toEqual([0, 1]);
    expect(service.holdTurnStart("other").startingAlready).toBe(0);
    first.release();
    first.release();
    second.release();
    expect(service.holdTurnStart("g").startingAlready).toBe(0);
  });

  it("remembers the newest threads an agent ran turns on, at most twenty", () => {
    const { service } = harness();
    for (let index = 0; index < 22; index += 1) service.noteTurnThread("g", `t-${index}`, "code");
    service.noteTurnThread("g", "t-5", "work");
    const threads = service.turnThreadsOf("g");
    expect(threads).toHaveLength(20);
    expect(threads.at(-1)).toEqual({ threadId: "t-5", mode: "work" });
    expect(threads.some((thread) => thread.threadId === "t-0")).toBe(false);
  });

  it("refuses a grant for a Project that is not there, and one without the Project's mode", () => {
    const { service } = harness();
    const unknown = service.execute(
      {
        kind: "create",
        draft: {
          name: "Bot",
          scope: scope({ projects: ["40000000-0000-4000-8000-000000000009" as never] }),
          days: 30,
        },
      },
      AGENT_ACCESS_LOCAL_ACTOR,
    );
    expect(unknown).toMatchObject({ kind: "refused", reason: "invalid" });
    const wrongMode = service.execute(
      { kind: "create", draft: { name: "Bot", scope: scope({ modes: ["work"] }), days: 30 } },
      AGENT_ACCESS_LOCAL_ACTOR,
    );
    expect(wrongMode).toMatchObject({ kind: "refused", reason: "invalid" });
  });

  it("cannot issue a connection code while remote access is off", () => {
    const { service } = harness({ listenerOn: false });
    const grantId = created(
      service.execute(
        { kind: "create", draft: { name: "Bot", scope: scope(), days: 30 } },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    );
    expect(
      service.execute(
        { kind: "issue-ticket", grantId: grantId as never },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    ).toMatchObject({ kind: "refused", reason: "listener-off" });
  });

  it("revokes a grant past its end date instead of accepting it", () => {
    const { service, clock } = harness();
    const grantId = created(
      service.execute(
        { kind: "create", draft: { name: "Bot", scope: scope({ direct: true }), days: 1 } },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    );
    const key = service.execute(
      { kind: "rotate-direct-key", grantId: grantId as never },
      AGENT_ACCESS_LOCAL_ACTOR,
    );
    if (key.kind !== "direct-key") throw new Error(key.kind);
    clock.now += 2 * 24 * 60 * 60 * 1_000;
    expect(
      service.authenticate({
        method: "POST",
        pathWithQuery: "/api/agent-access/mcp",
        body: new Uint8Array(),
        proof: null,
        authorization: `Bearer ${key.key}`,
        sourceClass: "lan-private",
      }).kind,
    ).toBe("unauthorized");
    expect(service.read(grantId)?.state).toBe("revoked");
  });

  it("counts turns against the grant's daily limit", () => {
    const { service } = harness();
    const grantId = created(
      service.execute(
        {
          kind: "create",
          draft: {
            name: "Bot",
            scope: scope({ limits: { ...DEFAULT_AGENT_GRANT_LIMITS, turnsPerDay: 2 } }),
            days: 30,
          },
        },
        AGENT_ACCESS_LOCAL_ACTOR,
      ),
    );
    expect([
      service.takeTurn(grantId),
      service.takeTurn(grantId),
      service.takeTurn(grantId),
    ]).toEqual([true, true, false]);
  });
});
