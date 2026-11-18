import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  resolveAwsProfileCredentials,
  type AwsProfilePorts,
  type AwsSsoMintOutcome,
} from "./awsProfileCredentials";
import { stsAssumeRole, type AwsStsOutcome } from "./awsSts";
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
    assumeRole: async () => ({ kind: "unavailable" }),
    assumeRoleWithWebIdentity: async () => ({ kind: "unavailable" }),
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

  it("refuses a missing profile and a role it cannot assume as written", async () => {
    const files = {
      [`${HOME}/.aws/config`]: [
        "[profile malformed]",
        "role_arn = arn:aws:iam::1:role/x",
        "source_profile = base",
        "[profile metadata]",
        "role_arn = arn:aws:iam::123456789012:role/Ops",
        "credential_source = Ec2InstanceMetadata",
        "[profile loop-a]",
        "role_arn = arn:aws:iam::123456789012:role/A",
        "source_profile = loop-b",
        "[profile loop-b]",
        "role_arn = arn:aws:iam::123456789012:role/B",
        "source_profile = loop-a",
      ].join("\n"),
    };
    const assumeRole = vi.fn(async () => roleAnswer("ASIAROLE000000000001"));
    for (const [name, reason] of [
      ["absent", "profile-missing"],
      ["malformed", "unsupported"],
      ["metadata", "unsupported"],
      ["loop-a", "unsupported"],
    ] as const) {
      expect(await resolveAwsProfileCredentials(name, ports(files, { assumeRole }))).toEqual({
        kind: "refused",
        reason,
      });
    }
    expect(assumeRole).not.toHaveBeenCalled();
  });
});

function roleAnswer(accessKeyId: string, expiresAt = NOW + 3_600_000): AwsStsOutcome {
  return {
    kind: "credentials",
    credentials: {
      accessKeyId,
      secretAccessKey: `${accessKeyId}-secret`,
      sessionToken: `${accessKeyId}-token`,
      expiresAt,
    },
  };
}

describe("a profile that assumes a role", () => {
  const chainedConfig = [
    "[profile base]",
    "region = eu-west-1",
    "[profile hop]",
    "role_arn = arn:aws:iam::123456789012:role/Hop",
    "source_profile = base",
    "[profile bedrock]",
    "role_arn = arn:aws:iam::210987654321:role/BedrockInvoke",
    "source_profile = hop",
    "role_session_name = person-at-laptop",
    "external_id = shared-external-id",
    "duration_seconds = 1800",
    "region = us-west-2",
  ].join("\n");

  it("assumes each role in a chain from the source profile's keys, as the AWS CLI does", async () => {
    const assumeRole = vi
      .fn<AwsProfilePorts["assumeRole"]>()
      .mockResolvedValueOnce(roleAnswer("ASIAHOP0000000000001"))
      .mockResolvedValueOnce(roleAnswer("ASIABEDROCK000000001"));
    const resolved = await resolveAwsProfileCredentials(
      "bedrock",
      ports(
        {
          [`${HOME}/.aws/config`]: chainedConfig,
          [`${HOME}/.aws/credentials`]: `[base]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n`,
        },
        { assumeRole },
      ),
    );
    expect(resolved).toEqual({ ...roleAnswer("ASIABEDROCK000000001"), via: "assume-role" });
    expect(assumeRole).toHaveBeenNthCalledWith(1, {
      region: undefined,
      roleArn: "arn:aws:iam::123456789012:role/Hop",
      roleSessionName: `octant-session-${Math.floor(NOW / 1_000)}`,
      source: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    });
    expect(assumeRole).toHaveBeenNthCalledWith(2, {
      region: "us-west-2",
      roleArn: "arn:aws:iam::210987654321:role/BedrockInvoke",
      roleSessionName: "person-at-laptop",
      externalId: "shared-external-id",
      durationSeconds: 1800,
      source: {
        accessKeyId: "ASIAHOP0000000000001",
        secretAccessKey: "ASIAHOP0000000000001-secret",
        sessionToken: "ASIAHOP0000000000001-token",
        expiresAt: NOW + 3_600_000,
      },
    });
  });

  it("signs with a source profile's own keys even when that source also names a role", async () => {
    const assumeRole = vi.fn(async () => roleAnswer("ASIABEDROCK000000001"));
    const resolved = await resolveAwsProfileCredentials(
      "bedrock",
      ports(
        {
          [`${HOME}/.aws/config`]: [
            "[profile base]",
            "role_arn = arn:aws:iam::123456789012:role/NotChained",
            "source_profile = elsewhere",
            "[profile bedrock]",
            "role_arn = arn:aws:iam::210987654321:role/BedrockInvoke",
            "source_profile = base",
          ].join("\n"),
          [`${HOME}/.aws/credentials`]: `[base]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n`,
        },
        { assumeRole },
      ),
    );
    expect(resolved).toMatchObject({ kind: "credentials", via: "assume-role" });
    expect(assumeRole).toHaveBeenCalledTimes(1);
    expect(assumeRole).toHaveBeenCalledWith(
      expect.objectContaining({
        roleArn: "arn:aws:iam::210987654321:role/BedrockInvoke",
        source: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
      }),
    );
  });

  it("assumes a role with the web identity token file and with the broker's environment keys", async () => {
    const assumeRoleWithWebIdentity = vi.fn(async () => roleAnswer("ASIAWEBIDENTITY00001"));
    const assumeRole = vi.fn(async () => roleAnswer("ASIAENVIRONMENT00001"));
    const files = {
      [`${HOME}/.aws/config`]: [
        "[profile federated]",
        "role_arn = arn:aws:iam::123456789012:role/Federated",
        "web_identity_token_file = ~/.aws/token",
        "[profile from-env]",
        "role_arn = arn:aws:iam::123456789012:role/FromEnv",
        "credential_source = Environment",
      ].join("\n"),
      [`${HOME}/.aws/token`]: "eyJhbGciOi.web-identity.token\n",
    };
    const env = { AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET };
    const reading = ports(files, { assumeRole, assumeRoleWithWebIdentity, env });
    expect(await resolveAwsProfileCredentials("federated", reading)).toMatchObject({
      kind: "credentials",
      via: "web-identity",
    });
    expect(assumeRoleWithWebIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ webIdentityToken: "eyJhbGciOi.web-identity.token" }),
    );
    expect(await resolveAwsProfileCredentials("from-env", reading)).toMatchObject({
      kind: "credentials",
      via: "assume-role",
    });
    expect(assumeRole).toHaveBeenCalledWith(
      expect.objectContaining({ source: { accessKeyId: KEY_ID, secretAccessKey: SECRET } }),
    );
  });

  it("refuses a role that asks for an MFA code, and names a refusal from the token service", async () => {
    const files = {
      [`${HOME}/.aws/config`]: [
        "[profile guarded]",
        "role_arn = arn:aws:iam::123456789012:role/Guarded",
        "source_profile = base",
        "mfa_serial = arn:aws:iam::123456789012:mfa/person",
        "[profile untrusted]",
        "role_arn = arn:aws:iam::123456789012:role/Untrusted",
        "source_profile = base",
      ].join("\n"),
      [`${HOME}/.aws/credentials`]: `[base]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n`,
    };
    const assumeRole = vi.fn(async (): Promise<AwsStsOutcome> => ({ kind: "refused" }));
    expect(await resolveAwsProfileCredentials("guarded", ports(files, { assumeRole }))).toEqual({
      kind: "refused",
      reason: "mfa-required",
    });
    expect(assumeRole).not.toHaveBeenCalled();
    expect(await resolveAwsProfileCredentials("untrusted", ports(files, { assumeRole }))).toEqual({
      kind: "refused",
      reason: "role-refused",
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

  it("assumes a profile's role at the token service, signs with it until it nears expiry, then assumes it again", async () => {
    const store = memoryStore();
    let clock = NOW;
    const stsCalls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    let issued = 0;
    // A stand-in for the regional token service: it answers AssumeRole in
    // the query protocol's XML, each time with new credentials for an hour.
    const fakeSts: typeof fetch = async (input, init) => {
      const url = String(input);
      stsCalls.push({ url, init });
      issued += 1;
      const expiration = new Date(clock + 3_600_000).toISOString();
      return new Response(
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASIAROLE00000000000${issued}</AccessKeyId><SecretAccessKey>role-secret-${issued}</SecretAccessKey><SessionToken>role-token-${issued}</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
        { status: 200, headers: { "content-type": "text/xml" } },
      );
    };
    const files: Record<string, string> = {
      [`${HOME}/.aws/config`]: [
        "[profile bedrock]",
        "role_arn = arn:aws:iam::123456789012:role/BedrockInvoke",
        "source_profile = base",
        "external_id = shared-external-id",
        "region = us-west-2",
      ].join("\n"),
      [`${HOME}/.aws/credentials`]: `[base]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n`,
    };
    const runtime = createCloudIamRuntime({
      store,
      fetch: fakeSts,
      now: () => clock,
      profiles: {
        readFile: async (path) => files[path],
        runCredentialProcess: async () => ({ exitCode: 1, stdout: "" }),
        homeDirectory: HOME,
        env: {},
      },
    });
    const { scope } = cloudDescriptor();
    const connected = await runtime.connect({
      descriptorId: "amazon-bedrock",
      source: { kind: "aws-profile", profileName: "bedrock" },
      scope,
      actorId: "00000000-0000-4000-8000-000000000001",
      termsAcknowledgedAt: new Date(NOW).toISOString(),
    });
    expect(connected).toMatchObject({ kind: "signed-in" });
    if (connected.kind !== "signed-in") throw new Error("not connected");

    expect(stsCalls).toHaveLength(1);
    const call = stsCalls[0];
    expect(call?.url).toBe("https://sts.us-west-2.amazonaws.com/");
    const body = new URLSearchParams(String(call?.init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      Action: "AssumeRole",
      RoleArn: "arn:aws:iam::123456789012:role/BedrockInvoke",
      ExternalId: "shared-external-id",
    });
    const stsHeaders = new Headers(call?.init?.headers);
    expect(stsHeaders.get("authorization")).toContain(
      `Credential=${KEY_ID}/20261116/us-west-2/sts/aws4_request`,
    );
    // The source secret signs the call and is never sent.
    expect(JSON.stringify(call)).not.toContain(SECRET);

    const request = {
      method: "POST",
      host: MODEL_HOST,
      path: MODEL_PATH,
      query: [],
      headers: { "content-type": "application/json" },
      payloadHash: "0".repeat(64),
    };
    const sign = () =>
      runtime.sign({ credentialRef: connected.credentialRef, request, renewCredentials: false });
    const first = await sign();
    expect(first).toMatchObject({ kind: "signed" });
    expect(JSON.stringify(first)).toContain("ASIAROLE000000000001");
    expect(JSON.stringify(first)).not.toContain("role-secret-1");
    expect(stsCalls).toHaveLength(1);

    clock = NOW + 58 * 60_000;
    const renewed = await sign();
    expect(stsCalls).toHaveLength(2);
    expect(JSON.stringify(renewed)).toContain("ASIAROLE000000000002");
  });

  it("reads a throttle from the token service as worth retrying and access denied as a refusal", async () => {
    const answer = (code: string) => async () =>
      new Response(
        `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>m</Message></Error></ErrorResponse>`,
        { status: code === "AccessDenied" ? 403 : 400, headers: { "content-type": "text/xml" } },
      );
    const input = {
      region: "us-west-2",
      roleArn: "arn:aws:iam::123456789012:role/BedrockInvoke",
      roleSessionName: "person",
      source: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    };
    expect(await stsAssumeRole(answer("Throttling"), NOW, input)).toEqual({ kind: "unavailable" });
    expect(await stsAssumeRole(answer("AccessDenied"), NOW, input)).toEqual({ kind: "refused" });
    expect(await stsAssumeRole(answer("ValidationError"), NOW, input)).toEqual({
      kind: "refused",
    });
  });
});
