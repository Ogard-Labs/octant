import {
  decodeDirectoryClientId,
  decodeDirectoryIssuer,
  decodeDirectoryIssuerClientId,
  decodeDirectoryResourceScope,
  decodeDirectoryTenantId,
  decodeProviderFailure,
  type DirectoryClientId,
  type DirectoryIssuer,
  type DirectoryIssuerClientId,
  type DirectoryResourceScope,
  type DirectoryTenantId,
  type ProviderFailure,
} from "@octant/contracts";
import {
  encodeDirectoryOAuthCredential,
  type DirectoryOAuthBinding,
  type DirectoryOAuthHost,
  type DirectoryOAuthUnauthenticatedReason,
} from "./directoryOAuth";
import { FakeDirectory, type FakeDirectoryRefreshAnswer } from "./fakeDirectory";

/** The fetch the runner hands a subject; it answers as the fake endpoint. */
export type DirectoryOAuthConformanceFetch = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * The instance's configuration as the runner sets it: a tenant and client
 * for a tenant kind, or the organization's issuer, client, and gateway scope
 * for an issuer kind.
 */
export type DirectoryOAuthConformanceConfiguration =
  | {
      readonly tenantId: DirectoryTenantId;
      readonly clientId: DirectoryClientId;
      readonly baseUrl: string;
    }
  | {
      readonly issuer: DirectoryIssuer;
      readonly clientId: DirectoryIssuerClientId;
      readonly scope: DirectoryResourceScope;
      readonly baseUrl: string;
    };

/** What the runner builds a subject from, as the host would build the driver. */
export interface DirectoryOAuthConformanceInput {
  readonly configuration: DirectoryOAuthConformanceConfiguration;
  /** The credential store's value for the instance, as the driver would read it. */
  readonly storedCredential: string | undefined;
  readonly host: DirectoryOAuthHost;
  readonly fetch: DirectoryOAuthConformanceFetch;
  readonly now: () => number;
}

/** What readiness shows after the driver's authenticated probe. */
export interface DirectoryOAuthProbeReport {
  readonly readiness: "ready" | "unauthenticated" | "unavailable" | "incompatible";
  readonly reason?: DirectoryOAuthUnauthenticatedReason;
  readonly capabilitiesClaimed: boolean;
  readonly message?: string;
}

/** A driver that declares `directory-oauth`, reduced to what the cases observe. */
export interface DirectoryOAuthConformanceSubject {
  readonly probe: () => Promise<DirectoryOAuthProbeReport>;
  /** One model request through the driver's transport; rejects with a `ProviderFailure`. */
  readonly send: () => Promise<void>;
}

interface DirectoryOAuthConformanceFixtureBase {
  /** A base URL the driver kind may send a bearer to (on its host list, if it has one). */
  readonly baseUrl: string;
  /** A second such base URL, at another origin. */
  readonly otherBaseUrl: string;
  readonly makeSubject: (input: DirectoryOAuthConformanceInput) => DirectoryOAuthConformanceSubject;
}

/**
 * A tenant kind names the one resource its endpoint accepts and keeps a
 * closed host list; an issuer kind is configured with the organization's own
 * issuer and scope and has no host list, since a gateway lives on the
 * organization's own host.
 */
export type DirectoryOAuthConformanceFixture =
  | (DirectoryOAuthConformanceFixtureBase & {
      readonly signsInTo: "tenant";
      /** The one resource this driver kind's endpoint accepts. */
      readonly audience: string;
    })
  | (DirectoryOAuthConformanceFixtureBase & { readonly signsInTo: "issuer" });

export type DirectoryOAuthConformanceCase =
  | "valid grant and binding is ready after the probe"
  | "no grant is unauthenticated without the broker or endpoint"
  | "near-expiry refresh happens once under concurrent requests"
  | "refresh refused as expired, revoked, or reused needs a new sign-in"
  | "refresh that needs the person present keeps the grant"
  | "unreachable broker or directory, or a 5xx, is unavailable and keeps the grant"
  | "pointer tenant, client, or audience differing from configuration is incompatible without the broker"
  | "pointer issuer, client, or scope differing from configuration is incompatible without the broker"
  | "base URL off the grant's origin or off the host list is incompatible without the broker"
  | "base URL off the grant's origin is incompatible without the broker"
  | "broker binding refusal is incompatible"
  | "missing role assignment is not-authorized"
  | "401 after a usable token refreshes once and resends once"
  | "no report or failure carries a token";

export interface DirectoryOAuthConformanceEvidence {
  readonly cases: ReadonlyArray<DirectoryOAuthConformanceCase>;
}

const TENANT = decodeDirectoryTenantId("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
const OTHER_TENANT = decodeDirectoryTenantId("1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516");
const CLIENT = decodeDirectoryClientId("0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d");
const OTHER_CLIENT = decodeDirectoryClientId("9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a");
const ISSUER = decodeDirectoryIssuer("https://login.directory-conformance.example/oauth2/gateway");
const OTHER_ISSUER = decodeDirectoryIssuer(
  "https://login.directory-conformance.example/oauth2/other",
);
const ISSUER_CLIENT = decodeDirectoryIssuerClientId("0oa1conformanceDesktop");
const OTHER_ISSUER_CLIENT = decodeDirectoryIssuerClientId("0oa1conformanceOther");
const SCOPE = decodeDirectoryResourceScope("gateway.models");
const OTHER_SCOPE = decodeDirectoryResourceScope("gateway.admin");
const OFF_LIST_BASE_URL = "https://directory-conformance.invalid/v1/";
const START = Date.parse("2026-10-26T09:00:00.000Z");
const HOUR = 3_600_000;
const NEAR_EXPIRY = 5_000;

/**
 * Prove a driver's `directory-oauth` path against a fake directory, broker,
 * and endpoint. Each case builds a fresh driver; a case that fails throws
 * with its name. The evidence names the cases and never carries a token.
 *
 * The broker's own cases (raw resolve refusing grant material, a remote
 * principal refused sign-in, refresh, and sign-out) are proved against the
 * broker itself, not a driver.
 */
export async function runDirectoryOAuthConformance(
  fixture: DirectoryOAuthConformanceFixture,
): Promise<DirectoryOAuthConformanceEvidence> {
  const run = new ConformanceRun(fixture);
  const cases: DirectoryOAuthConformanceCase[] = [];
  const prove = async (name: DirectoryOAuthConformanceCase, body: () => Promise<void>) => {
    try {
      await body();
    } catch (error) {
      const detail = error instanceof ConformanceViolation ? error.message : String(error);
      throw new Error(`Directory OAuth conformance failed: ${name}: ${detail}`);
    }
    cases.push(name);
  };
  check(
    origin(fixture.baseUrl) !== origin(fixture.otherBaseUrl),
    "the fixture's two base URLs share an origin",
  );

  await prove("valid grant and binding is ready after the probe", async () => {
    const scene = run.scene();
    const report = await scene.subject.probe();
    expectReady(report);
    const bearers = scene.endpoint.requests.map((request) => request.authorization);
    check(bearers.length > 0, "capabilities were claimed without an authenticated probe");
    check(
      bearers.every((value) => value !== undefined && scene.directory.accepts(bearerOf(value))),
      "the endpoint did not receive the directory's bearer",
    );
    await scene.send();
    check(
      scene.endpoint.requests.every((request) => request.origin === origin(fixture.baseUrl)),
      "a request went somewhere other than the configured endpoint",
    );
  });

  await prove("no grant is unauthenticated without the broker or endpoint", async () => {
    for (const storedCredential of [undefined, "fixture-api-key-not-a-sign-in"]) {
      const scene = run.scene({ storedCredential });
      expectRefused(await scene.subject.probe(), "unauthenticated", "missing");
      expectFailure(await scene.sendFailure(), "unauthenticated");
      scene.expectUntouched();
    }
  });

  await prove("near-expiry refresh happens once under concurrent requests", async () => {
    const scene = run.scene({ expiresInMs: NEAR_EXPIRY });
    const reports = await Promise.all([
      scene.subject.probe(),
      scene.subject.probe(),
      scene.subject.probe(),
    ]);
    for (const report of reports) expectReady(report);
    check(scene.directory.refreshExchanges() === 1, "concurrent requests refreshed more than once");
    check(
      scene.endpoint.requests.every(
        (request) =>
          request.authorization !== undefined &&
          scene.directory.accepts(bearerOf(request.authorization)),
      ),
      "a request carried the token that was about to expire",
    );
  });

  await prove("refresh refused as expired, revoked, or reused needs a new sign-in", async () => {
    const answers = [
      ["expired", "expired"],
      ["revoked", "revoked"],
      ["refresh-reused", "revoked"],
    ] as const;
    for (const [answer, reason] of answers) {
      const scene = run.scene({ expiresInMs: NEAR_EXPIRY, refreshAnswer: answer });
      expectRefused(await scene.subject.probe(), "unauthenticated", reason);
      check(!scene.directory.hasGrant(scene.credentialRef), "the refused grant was kept");
      // A dropped grant stays unusable even once the directory would answer again.
      scene.directory.answerRefreshWith("refreshed");
      expectRefused(await scene.subject.probe(), "unauthenticated");
      expectFailure(await scene.sendFailure(), "unauthenticated");
      check(scene.endpoint.requests.length === 0, "the endpoint was called without a grant");
    }
  });

  await prove("refresh that needs the person present keeps the grant", async () => {
    const scene = run.scene({ expiresInMs: NEAR_EXPIRY, refreshAnswer: "interaction-required" });
    expectRefused(await scene.subject.probe(), "unauthenticated", "interaction-required");
    check(scene.endpoint.requests.length === 0, "the endpoint was called without a token");
    scene.directory.answerRefreshWith("refreshed");
    expectReady(await scene.subject.probe());
  });

  await prove(
    "unreachable broker or directory, or a 5xx, is unavailable and keeps the grant",
    async () => {
      const brokerDown = run.scene();
      brokerDown.directory.setBrokerReachable(false);
      expectRefused(await brokerDown.subject.probe(), "unavailable");
      expectFailure(await brokerDown.sendFailure(), "unavailable");
      check(brokerDown.endpoint.requests.length === 0, "the endpoint was called without a token");
      brokerDown.directory.setBrokerReachable(true);
      expectReady(await brokerDown.subject.probe());

      for (const answer of ["unreachable", "server-error"] as const) {
        const scene = run.scene({ expiresInMs: NEAR_EXPIRY, refreshAnswer: answer });
        expectRefused(await scene.subject.probe(), "unavailable");
        check(scene.endpoint.requests.length === 0, "the endpoint was called without a token");
        scene.directory.answerRefreshWith("refreshed");
        expectReady(await scene.subject.probe());
      }
    },
  );

  await prove(
    fixture.signsInTo === "tenant"
      ? "pointer tenant, client, or audience differing from configuration is incompatible without the broker"
      : "pointer issuer, client, or scope differing from configuration is incompatible without the broker",
    async () => {
      // A pointer of the other kind is refused as well: a tenant pointer
      // never answers for an issuer, nor an issuer pointer for a tenant.
      const configured = run.configuredBinding();
      for (const pointer of [...differingBindings(configured), otherKindOf(configured)]) {
        // The broker holds a grant that matches the pointer, so only the
        // driver's own comparison with its configuration can refuse it.
        const scene = run.scene({ grant: pointer, pointer });
        expectRefused(await scene.subject.probe(), "incompatible");
        expectFailure(await scene.sendFailure(), "incompatible");
        scene.expectUntouched();
      }
    },
  );

  await prove(
    fixture.signsInTo === "tenant"
      ? "base URL off the grant's origin or off the host list is incompatible without the broker"
      : "base URL off the grant's origin is incompatible without the broker",
    async () => {
      const moved = run.scene({ baseUrl: fixture.otherBaseUrl });
      expectRefused(await moved.subject.probe(), "incompatible");
      expectFailure(await moved.sendFailure(), "incompatible");
      moved.expectUntouched();

      // An organization's gateway has no host list: the origin it was signed
      // in for is the only one that receives its bearer.
      if (fixture.signsInTo === "issuer") return;
      // Signed in for, and configured with, an address no driver of this kind
      // may reach: the host list refuses it although every other fact agrees.
      const offList = { ...run.configuredBinding(), endpointOrigin: origin(OFF_LIST_BASE_URL) };
      const unlisted = run.scene({ baseUrl: OFF_LIST_BASE_URL, grant: offList, pointer: offList });
      expectRefused(await unlisted.subject.probe(), "incompatible");
      expectFailure(await unlisted.sendFailure(), "incompatible");
      unlisted.expectUntouched();
    },
  );

  await prove("broker binding refusal is incompatible", async () => {
    // The pointer and configuration agree, but the grant itself was signed in
    // for another tenant or issuer: only the broker's re-check catches it.
    const [otherDirectory] = differingBindings(run.configuredBinding());
    const scene = run.scene({ grant: otherDirectory });
    expectRefused(await scene.subject.probe(), "incompatible");
    expectFailure(await scene.sendFailure(), "incompatible");
    check(scene.endpoint.requests.length === 0, "the endpoint was called after a binding refusal");
  });

  await prove("missing role assignment is not-authorized", async () => {
    const scene = run.scene({ roleAssigned: false });
    expectRefused(await scene.subject.probe(), "unauthenticated", "not-authorized");
    expectFailure(await scene.sendFailure(), "unauthenticated");
  });

  await prove("401 after a usable token refreshes once and resends once", async () => {
    const scene = run.scene();
    expectReady(await scene.subject.probe());
    const before = scene.endpoint.requests.length;
    scene.directory.refuseIssuedTokensAtEndpoint();
    await scene.send();
    const resent = scene.endpoint.requests.slice(before);
    check(
      resent.length === 2 && scene.directory.refreshExchanges() === 1,
      "a refused token was not renewed and resent exactly once",
    );
    check(
      resent[0]?.authorization !== resent[1]?.authorization,
      "the resend carried the refused token",
    );

    scene.endpoint.refuseEveryToken();
    const again = scene.endpoint.requests.length;
    expectFailure(await scene.sendFailure(), "unauthenticated");
    check(
      scene.endpoint.requests.length - again === 2 && scene.directory.refreshExchanges() === 2,
      "a second 401 did not end the request after one renewal",
    );
  });

  await prove("no report or failure carries a token", async () => {
    const reported = run.reported.join("\n");
    for (const token of run.issuedTokens()) {
      check(!reported.includes(token), "a report or failure carries a token");
    }
  });

  return { cases };
}

interface SceneOptions {
  readonly baseUrl?: string;
  readonly expiresInMs?: number;
  readonly refreshAnswer?: FakeDirectoryRefreshAnswer;
  /** The binding the broker's grant was signed in for, when not the configured one. */
  readonly grant?: DirectoryOAuthBinding;
  /** The binding the stored pointer names, when not the configured one. */
  readonly pointer?: DirectoryOAuthBinding;
  readonly storedCredential?: string | undefined;
  readonly roleAssigned?: boolean;
}

class ConformanceRun {
  readonly #fixture: DirectoryOAuthConformanceFixture;
  readonly #directories: FakeDirectory[] = [];
  readonly #reported: string[] = [];

  constructor(fixture: DirectoryOAuthConformanceFixture) {
    this.#fixture = fixture;
  }

  get reported(): ReadonlyArray<string> {
    return this.#reported;
  }

  issuedTokens(): ReadonlyArray<string> {
    return this.#directories.flatMap((directory) => directory.issuedTokens());
  }

  /** The binding the instance's configuration names at the fixture's base URL. */
  configuredBinding(): DirectoryOAuthBinding {
    const endpointOrigin = origin(this.#fixture.baseUrl);
    return this.#fixture.signsInTo === "tenant"
      ? { tenantId: TENANT, clientId: CLIENT, audience: this.#fixture.audience, endpointOrigin }
      : { issuer: ISSUER, clientId: ISSUER_CLIENT, scope: SCOPE, endpointOrigin };
  }

  scene(options: SceneOptions = {}) {
    const now = () => START;
    const directory = new FakeDirectory(now);
    this.#directories.push(directory);
    const configured = this.configuredBinding();
    const credentialRef = directory.signIn(options.grant ?? configured, {
      expiresInMs: options.expiresInMs ?? HOUR,
    });
    if (options.refreshAnswer !== undefined) directory.answerRefreshWith(options.refreshAnswer);
    const storedCredential =
      "storedCredential" in options
        ? options.storedCredential
        : encodeDirectoryOAuthCredential({
            kind: "directory-oauth",
            credentialRef,
            accountLabel: "person@contoso.example",
            ...(options.pointer ?? configured),
          });
    const endpoint = new FakeEndpoint(directory, options.roleAssigned ?? true);
    const subject = this.#fixture.makeSubject({
      configuration: {
        ...(this.#fixture.signsInTo === "tenant"
          ? { tenantId: TENANT, clientId: CLIENT }
          : { issuer: ISSUER, clientId: ISSUER_CLIENT, scope: SCOPE }),
        baseUrl: options.baseUrl ?? this.#fixture.baseUrl,
      },
      storedCredential,
      host: directory.host(),
      fetch: (url, init) => endpoint.answer(url, init),
      now,
    });
    const reported = this.#reported;
    const observed: DirectoryOAuthConformanceSubject = {
      probe: async () => {
        const report = await subject.probe();
        reported.push(JSON.stringify(report));
        return report;
      },
      send: subject.send,
    };
    const sendFailure = async (): Promise<ProviderFailure | undefined> => {
      try {
        await subject.send();
        return undefined;
      } catch (error) {
        reported.push(JSON.stringify(error), String(error));
        try {
          return decodeProviderFailure(error);
        } catch {
          throw new ConformanceViolation("a send rejected with no provider failure");
        }
      }
    };
    return {
      directory,
      endpoint,
      credentialRef,
      subject: observed,
      sendFailure,
      send: async () => {
        const failure = await sendFailure();
        check(failure === undefined, `a send failed as ${failure?.category ?? "nothing"}`);
      },
      expectUntouched: () => {
        check(directory.brokerCalls() === 0, "the broker was asked");
        check(endpoint.requests.length === 0, "the endpoint was called");
      },
    };
  }
}

/** A model endpoint that accepts only the directory's current tokens. */
class FakeEndpoint {
  readonly #directory: FakeDirectory;
  readonly #roleAssigned: boolean;
  readonly #requests: Array<{ readonly origin: string; readonly authorization?: string }> = [];
  #refusesEveryToken = false;

  constructor(directory: FakeDirectory, roleAssigned: boolean) {
    this.#directory = directory;
    this.#roleAssigned = roleAssigned;
  }

  get requests(): ReadonlyArray<{ readonly origin: string; readonly authorization?: string }> {
    return [...this.#requests];
  }

  refuseEveryToken(): void {
    this.#refusesEveryToken = true;
  }

  async answer(url: URL, init: RequestInit): Promise<Response> {
    const authorization = new Headers(init.headers).get("authorization") ?? undefined;
    this.#requests.push({
      origin: url.origin,
      ...(authorization === undefined ? {} : { authorization }),
    });
    if (
      authorization === undefined ||
      this.#refusesEveryToken ||
      !this.#directory.accepts(bearerOf(authorization))
    ) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!this.#roleAssigned) return Response.json({ error: "forbidden" }, { status: 403 });
    return init.method === "POST"
      ? Response.json({ choices: [{ message: { role: "assistant", content: "Hello." } }] })
      : Response.json({ data: [{ id: "deployment-fixture" }] });
  }
}

/** The configured binding with its directory, client, or resource changed, one at a time. */
function differingBindings(
  configured: DirectoryOAuthBinding,
): readonly [DirectoryOAuthBinding, DirectoryOAuthBinding, DirectoryOAuthBinding] {
  if ("tenantId" in configured) {
    return [
      { ...configured, tenantId: OTHER_TENANT },
      { ...configured, clientId: OTHER_CLIENT },
      { ...configured, audience: "https://another-resource.example.test" },
    ];
  }
  return [
    { ...configured, issuer: OTHER_ISSUER },
    { ...configured, clientId: OTHER_ISSUER_CLIENT },
    { ...configured, scope: OTHER_SCOPE },
  ];
}

/** A binding of the other directory kind at the same origin. */
function otherKindOf(configured: DirectoryOAuthBinding): DirectoryOAuthBinding {
  const endpointOrigin = configured.endpointOrigin;
  return "tenantId" in configured
    ? { issuer: ISSUER, clientId: ISSUER_CLIENT, scope: SCOPE, endpointOrigin }
    : {
        tenantId: TENANT,
        clientId: CLIENT,
        audience: "https://another-resource.example.test",
        endpointOrigin,
      };
}

class ConformanceViolation extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceViolation(message);
}

function expectReady(report: DirectoryOAuthProbeReport): void {
  check(report.readiness === "ready", `the probe read ${describe(report)}, not ready`);
  check(report.capabilitiesClaimed, "a ready probe claimed no capabilities");
}

function expectRefused(
  report: DirectoryOAuthProbeReport,
  readiness: Exclude<DirectoryOAuthProbeReport["readiness"], "ready">,
  reason?: DirectoryOAuthUnauthenticatedReason,
): void {
  const expected = reason === undefined ? readiness : `${readiness} (${reason})`;
  check(
    report.readiness === readiness && (reason === undefined || report.reason === reason),
    `the probe read ${describe(report)}, not ${expected}`,
  );
  check(!report.capabilitiesClaimed, "capabilities were claimed without an authenticated probe");
}

function expectFailure(
  failure: ProviderFailure | undefined,
  category: ProviderFailure["category"],
): void {
  check(
    failure?.category === category,
    `a send ${failure === undefined ? "succeeded" : `failed as ${failure.category}`}, not ${category}`,
  );
}

function describe(report: DirectoryOAuthProbeReport): string {
  return report.reason === undefined ? report.readiness : `${report.readiness} (${report.reason})`;
}

function bearerOf(authorization: string): string {
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
}

function origin(value: string): string {
  return new URL(value).origin;
}
