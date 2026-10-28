import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeWindowId,
  type HostOAuthJournalRecord,
  type ProviderInstance,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN } from "@octant/domain";
import {
  CredentialStoreFailure,
  startCredentialBroker,
  type CredentialBroker,
  type CredentialStore,
} from "@octant/host-runtime";
import { readCloudIamCredential } from "@octant/provider-sdk/cloud-iam";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { childProcessEnvironment } from "../childProcessEnvironment";
import { runOnNativeHarness } from "../harness/nativeHarnessEndpointDriver";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { makeAmazonBedrockDriver } from "./amazonBedrockDriver";
import {
  BEDROCK_HOST,
  BEDROCK_MODEL,
  FakeBedrockCloud,
  bedrockConfiguration,
  bedrockInstance,
} from "./bedrockCloudIam.test-support";
import { makeCredentialBrokerClient } from "./credentialBrokerClient";
import { cloudIamHostFromBroker, makeCloudIamBrokerClient } from "./oauth/cloudIamBroker";
import type { HostOAuthBrokerPort } from "./oauth/hostOAuthBrokerClient";
import { createHostOAuthService } from "./oauth/hostOAuthService";
import {
  answerCloudIamSettingsCommand,
  beginCloudIamSignIn,
  forgetCloudIamGrant,
} from "./oauth/providerCloudIamSignIn";
import { createProviderDeviceSignInRouteHandler } from "./oauth/providerDeviceSignInRoutes";
import { createProviderOAuthRouteHandler } from "./oauth/providerOAuthRoutes";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000b01");
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000b02");
const secret = "desktop-secret";
const capability = "E".repeat(43);

function memoryStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
  };
}

const open: CredentialBroker[] = [];

afterEach(async () => {
  for (const broker of open.splice(0)) await broker.close();
});

/**
 * The host as it runs: the real credential broker in front of a fake cloud,
 * and the server's own broker clients, sign-in routes, and Bedrock driver.
 * Every answer the broker gives the server is kept, so a test can show what
 * the server process ever held.
 */
async function host(options: { readonly instance?: () => ProviderInstance | undefined } = {}) {
  const cloud = new FakeBedrockCloud();
  const store = memoryStore();
  const broker = await startCredentialBroker(store, undefined, {
    fetch: cloud.fetch as typeof fetch,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  open.push(broker);
  const answers: string[] = [];
  const brokerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await broker.fetchForTest(
      new Request(input instanceof Request ? input.url : String(input), init),
    );
    const text = await response.text();
    answers.push(text);
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const credentials = makeCredentialBrokerClient({
    url: broker.url,
    token: broker.token,
    fetch: brokerFetch,
  });
  const cloudBroker = makeCloudIamBrokerClient({
    url: broker.url,
    token: broker.token,
    fetch: brokerFetch,
  });
  const journal: HostOAuthJournalRecord[] = [];
  const unusedOAuth: HostOAuthBrokerPort = {
    begin: async () => ({ kind: "refused", reason: "invalid" }),
    status: async () => ({ kind: "unknown" }),
    refresh: async () => ({ kind: "unavailable" }),
    access: async () => ({ kind: "unavailable" }),
    revoke: async () => ({ kind: "unavailable" }),
    forget: async () => undefined,
  };
  const oauthCalls: string[] = [];
  const hostOAuth = createHostOAuthService({
    journal: { append: (record) => void journal.push(record) },
    broker: {
      ...unusedOAuth,
      begin: async (input) => {
        oauthCalls.push(input.descriptor.descriptorId);
        return unusedOAuth.begin(input);
      },
    },
  });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  let current: ProviderInstance | undefined = bedrockInstance(String(instanceId));
  const readInstance = options.instance ?? (() => current);
  const cloudIam = {
    broker: cloudBroker,
    terms: hostOAuth,
    journal: { append: (record: HostOAuthJournalRecord) => void journal.push(record) },
    credentials,
    readInstance: () => readInstance(),
  };
  const route = createProviderDeviceSignInRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    readProviderInstances: () => {
      const instance = readInstance();
      return instance === undefined ? [] : [instance];
    },
    signIn: undefined,
    cloudIam,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    followIntervalMs: 1,
  });
  const command = async (path: "begin" | "poll", body: unknown) => {
    const response = await route(
      new Request(`http://127.0.0.1/api/desktop/provider-sign-in/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(body),
      }),
    );
    if (response === undefined) throw new Error("the route did not answer");
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    cloud,
    store,
    broker,
    answers,
    journal,
    oauthCalls,
    credentials,
    cloudBroker,
    cloudHost: cloudIamHostFromBroker(cloudBroker),
    terms: hostOAuth,
    command,
    browserRoute: createProviderOAuthRouteHandler({
      service: hostOAuth,
      windowAuthorityStore: authority,
      credentials,
      cloudIam,
      readInstance: () => readInstance(),
    }),
    cloudIam,
    removeInstance: () => {
      current = undefined;
    },
  };
}

async function signIn(
  scene: Awaited<ReturnType<typeof host>>,
  options: { readonly termsAcknowledged?: boolean } = {},
): Promise<Record<string, unknown>> {
  // The terms are asked once per host; a later sign-in begins at once.
  if (options.termsAcknowledged !== true) {
    const terms = await scene.command("begin", {
      instance: "Contoso Bedrock",
      acknowledgeTerms: false,
    });
    expect(terms.body).toMatchObject({
      outcome: "terms-required",
      termsSummary: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.termsSummary,
    });
  }
  const begun = await scene.command("begin", {
    instance: "Contoso Bedrock",
    acknowledgeTerms: options.termsAcknowledged !== true,
  });
  expect(begun.body).toMatchObject({
    outcome: "awaiting-code",
    verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
    userCode: "WXYZ-1234",
    warning: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.deviceCodeWarning,
  });
  scene.cloud.approve();
  const attemptId = String(begun.body.attemptId);
  const deadline = Date.now() + 3_000;
  for (;;) {
    const polled = await scene.command("poll", { instance: String(instanceId), attemptId });
    if (polled.body.outcome !== "waiting" || Date.now() > deadline) return polled.body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runTurn(
  driver: ReturnType<typeof runOnNativeHarness>,
  mode: "chat" | "work" | "code",
): Promise<ProviderRuntimeEvent[]> {
  const session = decodeProviderSessionId("80000000-0000-4000-8000-000000000b03");
  const events: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* driver.acquire({ instanceId, projectRoot: "/tmp", mode });
        yield* connection.start({
          sessionId: session,
          modelId: BEDROCK_MODEL,
          executionPolicy: "approval-gated",
        });
        const collector = yield* Effect.fork(
          (yield* connection.subscribe).pipe(
            Stream.filter((event) => event.sessionId === session),
            Stream.takeUntil(
              (event) =>
                event.kind === "completed" ||
                event.kind === "interrupted" ||
                event.kind === "failed",
            ),
            Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          ),
        );
        yield* connection.send({
          sessionId: session,
          prompt: `A ${mode} question.`,
          attachments: [],
          tools: [],
        });
        yield* collector.await;
      }),
    ),
  );
  return events;
}

describe("Amazon Bedrock with cloud single sign-on, end to end", () => {
  it("signs in from the host-local command and runs a Chat, a Work, and a Code turn the broker signs, with no key in the server", async () => {
    const scene = await host();
    const settled = await signIn(scene);
    expect(settled).toMatchObject({
      outcome: "signed-in",
      accountLabel: "BedrockInvoke in account 123456789012",
    });
    const stored = await scene.credentials.resolve(String(instanceId));
    const pointer = readCloudIamCredential(stored);
    expect(pointer).toMatchObject({
      kind: "cloud-iam",
      source: bedrockConfiguration().cloudIam,
      scope: { host: BEDROCK_HOST, service: "bedrock", method: "POST", pathPrefix: "/model/" },
    });
    expect(scene.journal.map((record) => record.name)).toEqual([
      "host-oauth.terms-acknowledged",
      "host-oauth.sign-in-started",
      "host-oauth.sign-in-completed",
    ]);

    const events: ProviderRuntimeEvent[] = [];
    const failures: unknown[] = [];
    const readiness: unknown[] = [];
    for (const mode of ["chat", "work", "code"] as const) {
      const runtimeRegistry = new ProviderRuntimeRegistry();
      const driver = makeAmazonBedrockDriver({
        instanceId,
        configuration: bedrockConfiguration(),
        runtimeRegistry,
        credentialResolver: scene.credentials,
        cloudIam: scene.cloudHost,
        fetch: (url, init) => scene.cloud.fetch(url, init),
      });
      const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
      readiness.push(observed);
      expect(observed.readiness, mode).toBe("ready");
      const turn = await runTurn(runOnNativeHarness(driver, { instanceId, runtimeRegistry }), mode);
      events.push(...turn);
      expect(turn.at(-1)?.kind, mode).toBe("completed");
      expect(
        turn.flatMap((event) => (event.kind === "text-delta" ? [event.text] : [])).join(""),
        mode,
      ).toBe(`Answered: A ${mode} question.`);
      failures.push(...turn.filter((event) => event.kind === "failed"));
    }
    // Every Bedrock request carried a signature made with role credentials
    // the portal minted, and nothing else was contacted.
    expect(scene.cloud.modelAuthorizations()).toHaveLength(3);
    for (const authorization of scene.cloud.modelAuthorizations()) {
      expect(authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=ASIA[0-9A-F]{16}\/\d{8}\/us-west-2\/bedrock\/aws4_request, /,
      );
    }
    expect(new Set(scene.cloud.hosts())).toEqual(
      new Set(["oidc.us-east-1.amazonaws.com", "portal.sso.us-east-1.amazonaws.com", BEDROCK_HOST]),
    );

    // The server process held a pointer and signature headers, never a key:
    // no broker answer, event, failure, readiness, or journal record carries
    // a secret the cloud issued. A role session token appears only in a
    // signature answer, beside the signature it belongs to.
    const held = [
      scene.answers.join("\n"),
      JSON.stringify(events),
      JSON.stringify(failures),
      JSON.stringify(readiness),
      JSON.stringify(scene.journal),
      stored,
    ].join("\n");
    expect(scene.cloud.secrets().length).toBeGreaterThanOrEqual(6);
    for (const issued of scene.cloud.secrets()) expect(held).not.toContain(issued);
    const outsideSignatures = [JSON.stringify(events), JSON.stringify(readiness), stored].join(
      "\n",
    );
    for (const token of scene.cloud.roleSessionTokens()) {
      expect(outsideSignatures).not.toContain(token);
    }
    // A child process starts from the server's environment, which never held
    // any of it and loses the broker's coordinates.
    const child = JSON.stringify(
      childProcessEnvironment({
        ...process.env,
        OCTANT_CREDENTIAL_BROKER_URL: scene.broker.url,
        OCTANT_CREDENTIAL_BROKER_TOKEN: scene.broker.token,
      }),
    );
    expect(child).not.toContain(scene.broker.token);
    for (const issued of [...scene.cloud.secrets(), ...scene.cloud.roleSessionTokens()]) {
      expect(child).not.toContain(issued);
    }
    for (const authorization of scene.cloud.modelAuthorizations()) {
      expect(child).not.toContain(authorization.slice(-64));
    }
  });

  it("forgets the grant of a sign-in finished after its instance was removed, and on sign-out", async () => {
    let instance: ProviderInstance | undefined = bedrockInstance(String(instanceId));
    const scene = await host({ instance: () => instance });
    const begun = await scene.command("begin", {
      instance: "Contoso Bedrock",
      acknowledgeTerms: true,
    });
    expect(begun.body.outcome).toBe("awaiting-code");
    instance = undefined;
    scene.cloud.approve();
    const deadline = Date.now() + 3_000;
    while (scene.cloud.logouts() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(scene.cloud.logouts()).toBe(1);
    expect(
      [...scene.store.values.values()].some((value) => value.includes("host-cloud-iam-grant")),
    ).toBe(false);

    instance = bedrockInstance(String(instanceId));
    expect(await signIn(scene, { termsAcknowledged: true })).toMatchObject({
      outcome: "signed-in",
    });
    const stored = await scene.credentials.resolve(String(instanceId));
    expect(await forgetCloudIamGrant(scene.cloudBroker, stored)).toBe(true);
    expect(scene.cloud.logouts()).toBe(2);
    const pointer = readCloudIamCredential(stored);
    expect(scene.store.values.has(pointer?.credentialRef ?? "")).toBe(false);
  });

  it("stores a sign-in only for the account and role the instance still names", async () => {
    let instance: ProviderInstance | undefined = bedrockInstance(String(instanceId));
    const scene = await host({ instance: () => instance });
    const begun = await scene.command("begin", {
      instance: "Contoso Bedrock",
      acknowledgeTerms: true,
    });
    expect(begun.body.outcome).toBe("awaiting-code");
    // The person changes the role while the code is open.
    instance = decodeProviderInstance({
      ...bedrockInstance(String(instanceId)),
      configuration: {
        ...bedrockConfiguration(),
        cloudIam: { ...bedrockConfiguration().cloudIam, roleName: "Administrator" },
      },
    });
    scene.cloud.approve();
    const deadline = Date.now() + 3_000;
    let polled = await scene.command("poll", {
      instance: String(instanceId),
      attemptId: String(begun.body.attemptId),
    });
    while (polled.body.outcome === "waiting" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      polled = await scene.command("poll", {
        instance: String(instanceId),
        attemptId: String(begun.body.attemptId),
      });
    }
    expect(polled.status).toBe(409);
    await expect(scene.credentials.resolve(String(instanceId))).rejects.toBeDefined();
    expect(scene.cloud.logouts()).toBe(1);
  });

  it("refuses a remote principal's cloud sign-in before any broker call", async () => {
    const scene = await host();
    const begun = await beginCloudIamSignIn({
      dependencies: {
        broker: scene.cloudBroker,
        terms: scene.terms,
        journal: { append: () => undefined },
        credentials: scene.credentials,
        readInstance: () => bedrockInstance(String(instanceId)),
      },
      instanceId,
      principal: "remote-device",
      actorId: String(windowId),
      acknowledgeTerms: true,
    });
    expect(begun.view).toEqual({ kind: "refused", reason: "local-host-required" });
    expect(scene.cloud.hosts()).toEqual([]);
    expect(scene.answers).toEqual([]);
  });

  it("shows Settings who is signed in and signs out there, asking the portal to end the session", async () => {
    const scene = await host();
    const settings = async (kind: string) => {
      const response = await scene.browserRoute(
        new Request("http://127.0.0.1/api/providers/oauth", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({
            kind,
            instanceId: String(instanceId),
            descriptorId: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.descriptorId,
          }),
        }),
      );
      return (await response?.json()) as Record<string, unknown> | undefined;
    };
    const accountLabel = "BedrockInvoke in account 123456789012";

    expect(await settings("status")).toEqual({
      kind: "signed-out",
      termsRequired: true,
      termsSummary: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.termsSummary,
      accountLabel,
    });
    expect(await signIn(scene)).toMatchObject({ outcome: "signed-in" });
    expect(await settings("status")).toEqual({ kind: "signed-in", accountLabel });

    expect(await settings("sign-out")).toMatchObject({ kind: "signed-out", accountLabel });
    expect(scene.cloud.logouts()).toBe(1);
    await expect(scene.credentials.resolve(String(instanceId))).rejects.toBeDefined();
    expect([...scene.store.values.keys()]).toEqual([]);
    expect(scene.journal.map((record) => record.name)).toContain("host-oauth.signed-out");
    expect(await settings("status")).toMatchObject({ kind: "signed-out", termsRequired: false });
    // Settings' answers name the account and nothing the broker holds.
    for (const value of [...scene.cloud.secrets(), ...scene.cloud.roleSessionTokens()]) {
      expect(JSON.stringify(scene.journal)).not.toContain(value);
    }
  });

  it("refuses a remote principal's Sign out, and every Settings command but status and Sign out, before any broker call", async () => {
    const scene = await host();
    expect(await signIn(scene)).toMatchObject({ outcome: "signed-in" });
    const answers = scene.answers.length;

    const remote = await answerCloudIamSettingsCommand({
      dependencies: scene.cloudIam,
      instanceId,
      kind: "sign-out",
      principal: "remote-device",
    });
    expect(remote).toEqual({ kind: "refused", reason: "local-host-required" });
    for (const kind of ["begin", "acknowledge", "poll", "sign-out-locally"] as const) {
      expect(
        await answerCloudIamSettingsCommand({
          dependencies: scene.cloudIam,
          instanceId,
          kind,
          principal: "local-window",
        }),
      ).toEqual({ kind: "refused", reason: "terminal-sign-in-only" });
    }
    expect(scene.answers).toHaveLength(answers);
    expect(scene.cloud.logouts()).toBe(0);
    await expect(scene.credentials.resolve(String(instanceId))).resolves.toBeDefined();
  });

  it("never begins a cloud sign-in from Settings' route", async () => {
    const scene = await host();
    for (const descriptorId of ["amazon-bedrock-cloud-iam", "azure-foundry-directory"]) {
      const response = await scene.browserRoute(
        new Request("http://127.0.0.1/api/providers/oauth", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({
            kind: "begin",
            instanceId: String(instanceId),
            descriptorId,
            attemptId: "",
            flow: "device-code",
          }),
        }),
      );
      const body = (await response?.json()) as Record<string, unknown> | undefined;
      expect(body?.kind).toBe("refused");
    }
    expect(scene.oauthCalls).toEqual([]);
    expect(scene.cloud.hosts()).toEqual([]);
  });
});
