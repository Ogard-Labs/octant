import {
  decodeCloudAccountId,
  decodeCloudIamRegion,
  decodeCloudIamStartUrl,
  decodeCloudRoleName,
  decodeProviderFailure,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  type AmazonBedrockProviderConfiguration,
} from "@octant/contracts";
import { amazonBedrockCloudIamDescriptor, amazonBedrockSigningScope } from "@octant/domain";
import {
  CredentialStoreFailure,
  startCredentialBroker,
  type CredentialStore,
} from "@octant/host-runtime";
import { encodeCloudIamCredential } from "@octant/provider-sdk/cloud-iam";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeAmazonBedrockDriver } from "./amazonBedrockDriver";
import { cloudIamHostFromBroker, makeCloudIamBrokerClient } from "./oauth/cloudIamBroker";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const smoke = process.env.OCTANT_BEDROCK_CLOUD_IAM_SMOKE === "1" ? it : it.skip;

/**
 * Real Amazon Bedrock through cloud single sign-on, for the maintainer.
 *
 * It starts the real credential broker with an in-memory store, signs in at
 * the organization's access portal with a device code (the page and code are
 * printed; enter the code in a browser), runs the probe and one Converse turn
 * the broker signs, optionally asks for a model the role may not invoke, and
 * signs out. Opt-in with OCTANT_BEDROCK_CLOUD_IAM_SMOKE=1 and the variables
 * below; without them it is skipped, which is a missing gate, never a pass.
 */
describe("real Amazon Bedrock with cloud single sign-on", () => {
  smoke(
    "signs in at the portal, runs a signed Converse turn, and signs out",
    async () => {
      const configuration: AmazonBedrockProviderConfiguration = {
        kind: "amazon-bedrock-converse-http",
        region: decodeCloudIamRegion(required("OCTANT_BEDROCK_SMOKE_REGION")),
        authentication: "cloud-iam",
        cloudIam: {
          startUrl: decodeCloudIamStartUrl(required("OCTANT_BEDROCK_SMOKE_START_URL")),
          ssoRegion: decodeCloudIamRegion(required("OCTANT_BEDROCK_SMOKE_SSO_REGION")),
          accountId: decodeCloudAccountId(required("OCTANT_BEDROCK_SMOKE_ACCOUNT_ID")),
          roleName: decodeCloudRoleName(required("OCTANT_BEDROCK_SMOKE_ROLE_NAME")),
        },
        manualModelIds: [decodeProviderModelId(required("OCTANT_BEDROCK_SMOKE_MODEL"))],
      };
      const values = new Map<string, string>();
      const store: CredentialStore = {
        set: async (id, value) => void values.set(id, value),
        has: async (id) => values.has(id),
        resolve: async (id) => {
          const value = values.get(id);
          if (value === undefined) throw new CredentialStoreFailure("missing");
          return value;
        },
        delete: async (id) => void values.delete(id),
      };
      const broker = await startCredentialBroker(store);
      try {
        const client = makeCloudIamBrokerClient({ url: broker.url, token: broker.token });
        const begun = (await client.begin({
          descriptor: amazonBedrockCloudIamDescriptor(configuration),
          actorId: "80000000-0000-4000-8000-000000000c01",
          termsAcknowledgedAt: new Date().toISOString(),
        })) as Record<string, unknown>;
        expect(begun.kind).toBe("awaiting-consent");
        console.log(
          `Open ${String(begun.verificationUri)} and enter ${String(begun.userCode)} within ten minutes.`,
        );
        let settled: Record<string, unknown> = begun;
        const deadline = Date.now() + 10 * 60_000;
        while (settled.kind === "awaiting-consent" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          settled = (await client.status(String(begun.attemptId))) as Record<string, unknown>;
        }
        // A role the person is not assigned is refused at sign-in with
        // nothing stored.
        if (process.env.OCTANT_BEDROCK_SMOKE_EXPECT_NOT_AUTHORIZED === "1") {
          expect(settled).toMatchObject({ kind: "refused", reason: "not-authorized" });
          expect(values.size).toBe(0);
          return;
        }
        expect(settled.kind).toBe("signed-in");
        const credentialRef = String(settled.credentialRef);
        const pointer = encodeCloudIamCredential({
          kind: "cloud-iam",
          credentialRef,
          source: configuration.cloudIam,
          scope: amazonBedrockSigningScope(configuration.region),
        });
        const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000c02");
        const runtimeRegistry = new ProviderRuntimeRegistry();
        const driver = makeAmazonBedrockDriver({
          instanceId,
          configuration,
          runtimeRegistry,
          credentialResolver: { has: async () => true, resolve: async () => pointer },
          cloudIam: cloudIamHostFromBroker(client),
        });
        const observed = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
        expect(observed.readiness).toBe("ready");
        const [modelId] = configuration.manualModelIds;
        if (modelId === undefined) throw new Error("no model");
        const session = await driver.harnessEndpoint.open(modelId);
        const deltas: string[] = [];
        const response = await session.send(
          {
            sessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000c03"),
            modelId,
            system: undefined,
            history: [{ role: "user", text: "Reply with exactly: octant-bedrock-cloud-iam-smoke" }],
            tools: [],
          },
          {
            signal: new AbortController().signal,
            onEvent: (event) => {
              if (event.kind === "text-delta") deltas.push(event.text);
            },
          },
        );
        session.release();
        expect(response.text).toContain("octant-bedrock-cloud-iam-smoke");
        expect(deltas.length).toBeGreaterThan(0);

        const denied = process.env.OCTANT_BEDROCK_SMOKE_DENIED_MODEL;
        if (denied !== undefined && denied.length > 0) {
          const deniedModel = decodeProviderModelId(denied);
          const deniedSession = await driver.harnessEndpoint.open(deniedModel);
          const failure = await deniedSession
            .send(
              {
                sessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000c04"),
                modelId: deniedModel,
                system: undefined,
                history: [{ role: "user", text: "Hello" }],
                tools: [],
              },
              { signal: new AbortController().signal, onEvent: () => undefined },
            )
            .then(
              () => undefined,
              (error: unknown) => decodeProviderFailure(error),
            );
          expect(failure?.category).toBe("unauthenticated");
        }

        expect(await client.revoke(credentialRef)).toEqual({ kind: "revoked" });
        expect(values.has(credentialRef)).toBe(false);
      } finally {
        await broker.close();
      }
    },
    15 * 60_000,
  );
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}
