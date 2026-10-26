import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexActiveModelProvider,
  codexBedrockSignIn,
  codexConfiguresBedrock,
  codexProviderCredential,
} from "./codexProviderCredential";

describe("codexActiveModelProvider", () => {
  it("names the selected provider and its declared env_key", () => {
    expect(
      codexActiveModelProvider(
        'model = "gpt-5"\nmodel_provider = "vendor"\n\n[model_providers.vendor]\nenv_key = "VENDOR_API_KEY"\n',
      ),
    ).toEqual({ id: "vendor", envKey: "VENDOR_API_KEY" });
  });

  it("unwraps a quoted provider table name and ignores comments", () => {
    expect(
      codexActiveModelProvider(
        'model_provider = "my.vendor"\n\n[model_providers."my.vendor"]\nenv_key = "MY_KEY" # the token\n',
      ),
    ).toEqual({ id: "my.vendor", envKey: "MY_KEY" });
  });

  it("answers nothing when no provider is selected or the table declares no env_key", () => {
    expect(codexActiveModelProvider('model = "gpt-5"\n')).toBeUndefined();
    expect(
      codexActiveModelProvider(
        'model_provider = "vendor"\n\n[model_providers.vendor]\nname = "V"\n',
      ),
    ).toEqual({ id: "vendor" });
  });
});

describe("codexProviderCredential", () => {
  it("names the active provider's env_key and whether the allowlist carries it", () => {
    const home = mkdtempSync(join(tmpdir(), "octant-codex-home-"));
    writeFileSync(
      join(home, "config.toml"),
      'model_provider = "vendor"\n\n[model_providers.vendor]\nenv_key = "VENDOR_API_KEY"\n',
    );
    try {
      // A custom env_key is not on the runtime allowlist, so the variable is
      // reported missing even when the host exports it.
      expect(codexProviderCredential({ CODEX_HOME: home, VENDOR_API_KEY: "sk-test" })).toEqual({
        envKey: "VENDOR_API_KEY",
        present: false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves both built-in Bedrock providers to the sign-in trace", () => {
    const home = mkdtempSync(join(tmpdir(), "octant-codex-home-"));
    try {
      for (const id of ["amazon-bedrock", "amazon-bedrock-runtime"]) {
        writeFileSync(join(home, "config.toml"), `model_provider = "${id}"\n`);
        const environment = { CODEX_HOME: home, AWS_BEARER_TOKEN_BEDROCK: "token" };
        expect(codexProviderCredential(environment)).toBeUndefined();
        expect(codexConfiguresBedrock(environment)).toBe(true);
      }
      writeFileSync(join(home, "config.toml"), 'model_provider = "openai"\n');
      expect(codexConfiguresBedrock({ CODEX_HOME: home })).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats an empty allowlisted credential as missing", () => {
    const home = mkdtempSync(join(tmpdir(), "octant-codex-home-"));
    writeFileSync(
      join(home, "config.toml"),
      'model_provider = "openai"\n\n[model_providers.openai]\nenv_key = "OPENAI_API_KEY"\n',
    );
    try {
      expect(codexProviderCredential({ CODEX_HOME: home, OPENAI_API_KEY: "" })).toEqual({
        envKey: "OPENAI_API_KEY",
        present: false,
      });
      expect(codexProviderCredential({ CODEX_HOME: home, OPENAI_API_KEY: "sk-test" })).toEqual({
        envKey: "OPENAI_API_KEY",
        present: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("answers nothing without a config or a selected provider", () => {
    const home = mkdtempSync(join(tmpdir(), "octant-codex-home-"));
    try {
      expect(codexProviderCredential({ CODEX_HOME: home })).toBeUndefined();
      writeFileSync(join(home, "config.toml"), 'model = "gpt-5"\n');
      expect(codexProviderCredential({ CODEX_HOME: home })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("codexBedrockSignIn", () => {
  const signIn = (
    providerConfig: unknown,
    environment: NodeJS.ProcessEnv = {},
    usesCodexManagedCredentials = false,
  ) => codexBedrockSignIn({ providerConfig, usesCodexManagedCredentials, environment });

  it("follows Codex's own order, so a profile outranks a stored key or a bearer token", () => {
    const bearer = { AWS_BEARER_TOKEN_BEDROCK: "token" };
    expect(signIn({ auth: { command: "token" }, aws: { profile: "work" } })).toEqual({
      status: "instance-scoped",
      source: "auth-command",
    });
    expect(signIn({ aws: { credential_export: { command: "aws" }, profile: "work" } })).toEqual({
      status: "refused",
      source: "credential-export",
    });
    expect(signIn({ aws: { profile: "work" } }, bearer, true)).toEqual({
      status: "refused",
      source: "aws-profile",
    });
    expect(signIn({ aws: { region: "us-east-1" } }, bearer, true)).toEqual({
      status: "instance-scoped",
      source: "codex-managed",
    });
    expect(signIn(undefined, bearer)).toEqual({
      status: "instance-scoped",
      source: "bearer-token",
    });
  });

  it("refuses the AWS default chain, which exported IAM keys and profile variables only feed", () => {
    for (const environment of [
      {},
      { AWS_BEARER_TOKEN_BEDROCK: "  " },
      { AWS_PROFILE: "work", AWS_CONFIG_FILE: "/Users/test/.aws/config" },
      { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" },
    ]) {
      expect(signIn({ aws: { region: "us-east-1" } }, environment)).toEqual({
        status: "refused",
        source: "aws-default-chain",
      });
    }
  });
});
