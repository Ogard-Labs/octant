import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  resolveAwsProfileCredentials,
  type AwsProfilePorts,
  type AwsSsoMintOutcome,
} from "./awsProfileCredentials";
import { createCloudIamRuntime, isCloudIamGrantMaterial } from "./cloudIam";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { MODEL_HOST, MODEL_PATH, cloudDescriptor } from "./fakeCloudIam.test-support";

const HOME = "/home/person";
const KEY_ID = "AKIAEXAMPLEKEY000001";
const SECRET = "wJalrXUtnFEMIexampleSECRETkey0000000000";
const NOW = Date.parse("2026-11-16T12:00:00Z");

function ports(
  files: Readonly<Record<string, string>>,
  overrides: Partial<AwsProfilePorts> = {},
): AwsProfilePorts {
  return {
    readFile: async (path) => files[path],
    runCredentialProcess: async () => ({ exitCode: 1, stdout: "" }),
    mintSsoRoleCredentials: async () => ({ kind: "unavailable" }),
    homeDirectory: HOME,
    env: {},
    now: () => NOW,
    ...overrides,
  };
}

describe("reading the person's AWS profile in the broker", () => {
  it("prefers the shared credentials file's keys for a named profile", async () => {
    const resolved = await resolveAwsProfileCredentials(
      "work",
      ports({
        [`${HOME}/.aws/credentials`]: `[work]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n`,
        [`${HOME}/.aws/config`]: "[profile work]\nregion = us-east-1\n",
      }),
    );
    expect(resolved).toEqual({
      kind: "credentials",
      via: "static-keys",
      credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    });
  });

  it("mints the role from the token the AWS CLI cached for an sso-session", async () => {
    const mint = vi.fn(
      async (): Promise<AwsSsoMintOutcome> => ({
        kind: "credentials",
        credentials: {
          accessKeyId: KEY_ID,
          secretAccessKey: SECRET,
          sessionToken: "session-token",
          expiresAt: NOW + 3_600_000,
        },
      }),
    );
    const cache = createHash("sha1").update("corp").digest("hex");
    const config = [
      "[profile work]",
      "sso_session = corp",
      "sso_account_id = 123456789012",
      "sso_role_name = Developer",
      "[sso-session corp]",
      "sso_start_url = https://corp.awsapps.com/start",
      "sso_region = us-east-1",
    ].join("\n");
    const files = {
      [`${HOME}/.aws/config`]: config,
      [`${HOME}/.aws/sso/cache/${cache}.json`]: JSON.stringify({
        accessToken: "cached-access-token",
        expiresAt: "2026-11-16T13:00:00Z",
      }),
    };
    const resolved = await resolveAwsProfileCredentials(
      "work",
      ports(files, { mintSsoRoleCredentials: mint }),
    );
    expect(resolved).toMatchObject({ kind: "credentials", via: "sso" });
    expect(mint).toHaveBeenCalledWith({
      ssoRegion: "us-east-1",
      accountId: "123456789012",
      roleName: "Developer",
      accessToken: "cached-access-token",
    });

    const expired = await resolveAwsProfileCredentials(
      "work",
      ports({ [`${HOME}/.aws/config`]: config }, { mintSsoRoleCredentials: mint }),
    );
    expect(expired).toEqual({ kind: "refused", reason: "sso-sign-in-needed" });
  });

  it("reads what the profile's credential_process prints, and refuses anything else", async () => {
    const config = `[profile tool]\ncredential_process = /usr/local/bin/issue-keys --profile tool\n`;
    const printed = JSON.stringify({
      Version: 1,
      AccessKeyId: KEY_ID,
      SecretAccessKey: SECRET,
      SessionToken: "process-token",
      Expiration: "2026-11-16T13:00:00Z",
    });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: printed }));
    expect(
      await resolveAwsProfileCredentials(
        "tool",
        ports({ [`${HOME}/.aws/config`]: config }, { runCredentialProcess: run }),
      ),
    ).toMatchObject({
      kind: "credentials",
      via: "credential-process",
      credentials: { sessionToken: "process-token", expiresAt: NOW + 3_600_000 },
    });
    expect(run).toHaveBeenCalledWith("/usr/local/bin/issue-keys --profile tool");
    expect(
      await resolveAwsProfileCredentials(
        "tool",
        ports(
          { [`${HOME}/.aws/config`]: config },
          { runCredentialProcess: async () => ({ exitCode: 0, stdout: "not json" }) },
        ),
      ),
    ).toEqual({ kind: "refused", reason: "process-failed" });
  });

  it("refuses a missing profile and one that only assumes a role", async () => {
    const files = {
      [`${HOME}/.aws/config`]:
        "[profile chained]\nrole_arn = arn:aws:iam::1:role/x\nsource_profile = base\n",
    };
    expect(await resolveAwsProfileCredentials("absent", ports(files))).toEqual({
      kind: "refused",
      reason: "profile-missing",
    });
    expect(await resolveAwsProfileCredentials("chained", ports(files))).toEqual({
      kind: "refused",
      reason: "unsupported",
    });
  });
});

describe("a cloud grant from the person's own keys", () => {
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

  it("keeps long-lived keys in the broker, signs within the scope only, and forgets them on sign-out", async () => {
    const store = memoryStore();
    const runtime = createCloudIamRuntime({ store, now: () => NOW });
    const { scope } = cloudDescriptor();
    const connected = await runtime.connect({
      descriptorId: "amazon-bedrock",
      source: { kind: "access-keys", accessKeyId: KEY_ID, secretAccessKey: SECRET },
      scope,
      actorId: "00000000-0000-4000-8000-000000000001",
      termsAcknowledgedAt: new Date(NOW).toISOString(),
    });
    expect(connected).toMatchObject({ kind: "signed-in" });
    if (connected.kind !== "signed-in") throw new Error("not connected");
    // The stored grant is cloud material: no raw resolve may release it.
    expect(isCloudIamGrantMaterial(store.values.get(connected.credentialRef) ?? "")).toBe(true);
    expect(JSON.stringify(connected)).not.toContain(SECRET);

    const request = {
      method: "POST",
      host: MODEL_HOST,
      path: MODEL_PATH,
      query: [],
      headers: { "content-type": "application/json" },
      payloadHash: "0".repeat(64),
    };
    const signed = await runtime.sign({
      credentialRef: connected.credentialRef,
      request,
      renewCredentials: false,
    });
    expect(signed).toMatchObject({ kind: "signed" });
    expect(JSON.stringify(signed)).not.toContain(SECRET);
    expect(
      await runtime.sign({
        credentialRef: connected.credentialRef,
        request: { ...request, host: "bedrock-runtime.eu-west-1.amazonaws.com" },
        renewCredentials: false,
      }),
    ).toEqual({ kind: "outside-scope" });

    expect(await runtime.revoke(connected.credentialRef)).toEqual({ kind: "revoked" });
    expect(store.values.has(connected.credentialRef)).toBe(false);
  });
});
