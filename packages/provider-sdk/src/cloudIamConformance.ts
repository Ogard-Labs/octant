import {
  decodeCloudAccountId,
  decodeCloudIamRegion,
  decodeCloudIamStartUrl,
  decodeCloudRoleName,
  decodeProviderFailure,
  type CloudIamRegion,
  type CloudIamSigningScope,
  type CloudIamSourceIdentity,
  type ProviderFailure,
} from "@octant/contracts";
import {
  encodeCloudIamCredential,
  type CloudIamHost,
  type CloudIamUnauthenticatedReason,
} from "./cloudIam";
import { FakeCloudSigner } from "./fakeCloudSigner";

/** The fetch the runner hands a subject; it answers as the fake endpoint. */
export type CloudIamConformanceFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** The instance's configuration as the runner sets it. */
export interface CloudIamConformanceConfiguration {
  readonly region: CloudIamRegion;
  readonly cloudIam: CloudIamSourceIdentity;
}

/** What the runner builds a subject from, as the host would build the driver. */
export interface CloudIamConformanceInput {
  readonly configuration: CloudIamConformanceConfiguration;
  /** The credential store's value for the instance, as the driver would read it. */
  readonly storedCredential: string | undefined;
  readonly host: CloudIamHost;
  readonly fetch: CloudIamConformanceFetch;
  readonly now: () => number;
}

/** What readiness shows after the driver's probe. */
export interface CloudIamProbeReport {
  readonly readiness: "ready" | "unauthenticated" | "unavailable" | "incompatible";
  readonly reason?: CloudIamUnauthenticatedReason;
  readonly capabilitiesClaimed: boolean;
  readonly message?: string;
}

/** A driver that declares `cloud-iam`, reduced to what the cases observe. */
export interface CloudIamConformanceSubject {
  readonly probe: () => Promise<CloudIamProbeReport>;
  /** One model request through the driver's transport; rejects with a `ProviderFailure`. */
  readonly send: () => Promise<void>;
}

export interface CloudIamConformanceFixture {
  /** The scope the driver kind signs for in a region: its own host, path prefix, and method. */
  readonly scopeFor: (region: CloudIamRegion) => CloudIamSigningScope;
  /** The endpoint's own answer to a request whose signature verified. */
  readonly answer: (url: URL, init: RequestInit) => Response;
  readonly makeSubject: (input: CloudIamConformanceInput) => CloudIamConformanceSubject;
}

export type CloudIamConformanceCase =
  | "valid grant and scope is ready after the probe and every request verifies at the endpoint"
  | "no grant is unauthenticated without the broker or endpoint"
  | "sign-in that ended or was withdrawn needs a new sign-in"
  | "role the portal no longer gives is not-authorized and keeps the grant"
  | "unreachable broker is unavailable"
  | "pointer portal, account, role, or region differing from configuration is incompatible without the broker"
  | "broker scope refusal is incompatible"
  | "endpoint refusing the role's permission is not-authorized"
  | "refused credentials renew once and resend once"
  | "no report or failure carries a secret, token, or signature";

export interface CloudIamConformanceEvidence {
  readonly cases: ReadonlyArray<CloudIamConformanceCase>;
}

const REGION = decodeCloudIamRegion("us-west-2");
const OTHER_REGION = decodeCloudIamRegion("eu-central-1");
const SOURCE: CloudIamSourceIdentity = {
  startUrl: decodeCloudIamStartUrl("https://contoso-conformance.awsapps.com/start"),
  ssoRegion: decodeCloudIamRegion("us-east-1"),
  accountId: decodeCloudAccountId("123456789012"),
  roleName: decodeCloudRoleName("ModelInvoke"),
};
const START = Date.parse("2026-10-27T09:00:00.000Z");

/**
 * Prove a driver's `cloud-iam` path against a fake signer and endpoint. Each
 * case builds a fresh driver; a case that fails throws with its name. The
 * evidence names the cases and never carries a secret.
 *
 * The broker's own cases (a request outside the scope or one that brings its
 * own digest refused unsigned, a replayed request failing to verify, a raw
 * resolve refusing grant material, a remote principal refused) are proved
 * against the broker itself, not a driver.
 */
export async function runCloudIamConformance(
  fixture: CloudIamConformanceFixture,
): Promise<CloudIamConformanceEvidence> {
  const run = new ConformanceRun(fixture);
  const cases: CloudIamConformanceCase[] = [];
  const prove = async (name: CloudIamConformanceCase, body: () => Promise<void>) => {
    try {
      await body();
    } catch (error) {
      const detail = error instanceof ConformanceViolation ? error.message : String(error);
      throw new Error(`Cloud IAM conformance failed: ${name}: ${detail}`);
    }
    cases.push(name);
  };

  await prove(
    "valid grant and scope is ready after the probe and every request verifies at the endpoint",
    async () => {
      const scene = run.scene();
      expectReady(await scene.subject.probe());
      check(scene.signer.signCalls() > 0, "capabilities were claimed without asking the signer");
      await scene.send();
      check(scene.endpoint.requests.length > 0, "the endpoint received no request");
      check(
        scene.endpoint.requests.every((request) => request.verdict === "valid"),
        "a request did not carry a signature over exactly what it sent",
      );
      const host = fixture.scopeFor(REGION).host;
      check(
        scene.endpoint.requests.every((request) => request.host === host),
        "a request went somewhere other than the scope's host",
      );
    },
  );

  await prove("no grant is unauthenticated without the broker or endpoint", async () => {
    const directoryPointer = JSON.stringify({
      kind: "directory-oauth",
      credentialRef: crypto.randomUUID(),
    });
    for (const storedCredential of [undefined, "fixture-api-key-not-a-sign-in", directoryPointer]) {
      const scene = run.scene({ storedCredential });
      expectRefused(await scene.subject.probe(), "unauthenticated", "missing");
      expectFailure(await scene.sendFailure(), "unauthenticated");
      scene.expectUntouched();
    }
  });

  await prove("sign-in that ended or was withdrawn needs a new sign-in", async () => {
    for (const reason of ["expired", "revoked"] as const) {
      const scene = run.scene();
      scene.signer.answerSignWith(reason);
      expectRefused(await scene.subject.probe(), "unauthenticated", reason);
      check(!scene.signer.hasGrant(scene.credentialRef), "the ended grant was kept");
      scene.signer.answerSignWith("signed");
      expectRefused(await scene.subject.probe(), "unauthenticated");
      expectFailure(await scene.sendFailure(), "unauthenticated");
      check(scene.endpoint.requests.length === 0, "the endpoint was called without a grant");
    }
  });

  await prove("role the portal no longer gives is not-authorized and keeps the grant", async () => {
    const scene = run.scene();
    scene.signer.answerSignWith("not-authorized");
    expectRefused(await scene.subject.probe(), "unauthenticated", "not-authorized");
    expectFailure(await scene.sendFailure(), "unauthenticated");
    check(scene.endpoint.requests.length === 0, "the endpoint was called without a signature");
    scene.signer.answerSignWith("signed");
    expectReady(await scene.subject.probe());
  });

  await prove("unreachable broker is unavailable", async () => {
    const scene = run.scene();
    scene.signer.answerSignWith("unreachable");
    expectRefused(await scene.subject.probe(), "unavailable");
    expectFailure(await scene.sendFailure(), "unavailable");
    check(scene.endpoint.requests.length === 0, "the endpoint was called without a signature");
    scene.signer.answerSignWith("signed");
    expectReady(await scene.subject.probe());
  });

  await prove(
    "pointer portal, account, role, or region differing from configuration is incompatible without the broker",
    async () => {
      const differing: ReadonlyArray<{
        readonly source: CloudIamSourceIdentity;
        readonly region: CloudIamRegion;
      }> = [
        {
          source: {
            ...SOURCE,
            startUrl: decodeCloudIamStartUrl("https://fabrikam-conformance.awsapps.com/start"),
          },
          region: REGION,
        },
        { source: { ...SOURCE, ssoRegion: decodeCloudIamRegion("eu-west-1") }, region: REGION },
        { source: { ...SOURCE, accountId: decodeCloudAccountId("210987654321") }, region: REGION },
        { source: { ...SOURCE, roleName: decodeCloudRoleName("Administrator") }, region: REGION },
        { source: SOURCE, region: OTHER_REGION },
      ];
      for (const pointer of differing) {
        // The signer holds a grant that matches the pointer, so only the
        // driver's own comparison with its configuration can refuse it.
        const scene = run.scene({ grant: pointer, pointer });
        expectRefused(await scene.subject.probe(), "incompatible");
        expectFailure(await scene.sendFailure(), "incompatible");
        scene.expectUntouched();
      }
    },
  );

  await prove("broker scope refusal is incompatible", async () => {
    // The pointer and configuration agree, but the grant itself was signed in
    // for another region: only the broker's own scope check catches it.
    const scene = run.scene({ grant: { source: SOURCE, region: OTHER_REGION } });
    expectRefused(await scene.subject.probe(), "incompatible");
    expectFailure(await scene.sendFailure(), "incompatible");
    check(scene.endpoint.requests.length === 0, "the endpoint was called after a scope refusal");
  });

  await prove("endpoint refusing the role's permission is not-authorized", async () => {
    const scene = run.scene({ permitted: false });
    expectFailure(await scene.sendFailure(), "unauthenticated");
    check(scene.signer.renewals() === 0, "a missing permission renewed the credentials");
    check(
      scene.reported.some((line) => line.includes("no access")),
      "a missing permission did not read as no access",
    );
  });

  await prove("refused credentials renew once and resend once", async () => {
    const scene = run.scene();
    await scene.send();
    const before = scene.endpoint.requests.length;
    scene.signer.expireCredentials();
    await scene.send();
    const resent = scene.endpoint.requests.slice(before);
    check(
      resent.length === 2 && scene.signer.renewals() === 1,
      "refused credentials were not renewed and resent exactly once",
    );
    check(resent[1]?.verdict === "valid", "the resend carried the refused credentials");

    scene.endpoint.refuseEverySignature();
    const again = scene.endpoint.requests.length;
    expectFailure(await scene.sendFailure(), "unauthenticated");
    check(
      scene.endpoint.requests.length - again === 2 && scene.signer.renewals() === 2,
      "a second refusal did not end the request after one renewal",
    );
  });

  await prove("no report or failure carries a secret, token, or signature", async () => {
    const reported = run.reported.join("\n");
    for (const secret of run.secrets()) {
      check(!reported.includes(secret), "a report or failure carries a secret or token");
    }
    check(!reported.includes("FAKE-CLOUD-SIGNATURE"), "a report or failure carries a signature");
  });

  return { cases };
}

interface SceneOptions {
  /** What the signer's grant was signed in for, when not the configured one. */
  readonly grant?: { readonly source: CloudIamSourceIdentity; readonly region: CloudIamRegion };
  /** What the stored pointer names, when not the configured one. */
  readonly pointer?: { readonly source: CloudIamSourceIdentity; readonly region: CloudIamRegion };
  readonly storedCredential?: string | undefined;
  /** Whether the role holds the permission the endpoint checks. */
  readonly permitted?: boolean;
}

class ConformanceRun {
  readonly #fixture: CloudIamConformanceFixture;
  readonly #signers: FakeCloudSigner[] = [];
  readonly #reported: string[] = [];

  constructor(fixture: CloudIamConformanceFixture) {
    this.#fixture = fixture;
  }

  get reported(): ReadonlyArray<string> {
    return this.#reported;
  }

  secrets(): ReadonlyArray<string> {
    return this.#signers.flatMap((signer) => signer.secrets());
  }

  scene(options: SceneOptions = {}) {
    const now = () => START;
    const signer = new FakeCloudSigner();
    this.#signers.push(signer);
    const grant = options.grant ?? { source: SOURCE, region: REGION };
    const credentialRef = signer.signIn(grant.source, this.#fixture.scopeFor(grant.region));
    const pointer = options.pointer ?? { source: SOURCE, region: REGION };
    const storedCredential =
      "storedCredential" in options
        ? options.storedCredential
        : encodeCloudIamCredential({
            kind: "cloud-iam",
            credentialRef,
            source: pointer.source,
            scope: this.#fixture.scopeFor(pointer.region),
          });
    const endpoint = new FakeEndpoint(signer, this.#fixture, options.permitted ?? true);
    const subject = this.#fixture.makeSubject({
      configuration: { region: REGION, cloudIam: SOURCE },
      storedCredential,
      host: signer.host(),
      fetch: (url, init) => endpoint.answer(url, init),
      now,
    });
    const reported = this.#reported;
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
      signer,
      endpoint,
      credentialRef,
      reported,
      subject: {
        probe: async () => {
          const report = await subject.probe();
          reported.push(JSON.stringify(report));
          return report;
        },
        send: subject.send,
      } satisfies CloudIamConformanceSubject,
      sendFailure,
      send: async () => {
        const failure = await sendFailure();
        check(failure === undefined, `a send failed as ${failure?.category ?? "nothing"}`);
      },
      expectUntouched: () => {
        check(signer.signCalls() === 0, "the signer was asked");
        check(endpoint.requests.length === 0, "the endpoint was called");
      },
    };
  }
}

/** A model endpoint that answers only requests whose signature verifies. */
class FakeEndpoint {
  readonly #signer: FakeCloudSigner;
  readonly #fixture: CloudIamConformanceFixture;
  readonly #permitted: boolean;
  readonly #requests: Array<{ readonly host: string; readonly verdict: string }> = [];
  #refusesEverySignature = false;

  constructor(signer: FakeCloudSigner, fixture: CloudIamConformanceFixture, permitted: boolean) {
    this.#signer = signer;
    this.#fixture = fixture;
    this.#permitted = permitted;
  }

  get requests(): ReadonlyArray<{ readonly host: string; readonly verdict: string }> {
    return [...this.#requests];
  }

  refuseEverySignature(): void {
    this.#refusesEverySignature = true;
  }

  async answer(url: URL, init: RequestInit): Promise<Response> {
    const verdict = this.#refusesEverySignature ? "expired" : await this.#signer.verify(url, init);
    this.#requests.push({ host: url.host, verdict });
    // The cloud names a refusal's kind in its error-type header; the body is
    // a message a driver must not read.
    if (verdict !== "valid") {
      return Response.json(
        { message: "fixture refusal" },
        {
          status: 403,
          headers: {
            "x-amzn-errortype":
              verdict === "expired" ? "ExpiredTokenException" : "InvalidSignatureException",
          },
        },
      );
    }
    if (!this.#permitted) {
      return Response.json(
        { message: "fixture refusal" },
        { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException" } },
      );
    }
    return this.#fixture.answer(url, init);
  }
}

class ConformanceViolation extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceViolation(message);
}

function expectReady(report: CloudIamProbeReport): void {
  check(report.readiness === "ready", `the probe read ${describe(report)}, not ready`);
  check(report.capabilitiesClaimed, "a ready probe claimed no capabilities");
}

function expectRefused(
  report: CloudIamProbeReport,
  readiness: Exclude<CloudIamProbeReport["readiness"], "ready">,
  reason?: CloudIamUnauthenticatedReason,
): void {
  const expected = reason === undefined ? readiness : `${readiness} (${reason})`;
  check(
    report.readiness === readiness && (reason === undefined || report.reason === reason),
    `the probe read ${describe(report)}, not ${expected}`,
  );
  check(!report.capabilitiesClaimed, "capabilities were claimed without a signature");
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

function describe(report: CloudIamProbeReport): string {
  return report.reason === undefined ? report.readiness : `${report.readiness} (${report.reason})`;
}
