import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexActiveModelProvider,
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
      codexActiveModelProvider('model_provider = "vendor"\n\n[model_providers.vendor]\nname = "V"\n'),
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
      expect(
        codexProviderCredential({ CODEX_HOME: home, VENDOR_API_KEY: "sk-test" }),
      ).toEqual({ envKey: "VENDOR_API_KEY", present: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats the built-in Bedrock provider's credential as present only when exported", () => {
    const home = mkdtempSync(join(tmpdir(), "octant-codex-home-"));
    writeFileSync(join(home, "config.toml"), 'model_provider = "amazon-bedrock"\n');
    try {
      expect(codexProviderCredential({ CODEX_HOME: home })).toEqual({
        envKey: "AWS_BEARER_TOKEN_BEDROCK",
        present: false,
      });
      expect(
        codexProviderCredential({ CODEX_HOME: home, AWS_BEARER_TOKEN_BEDROCK: "token" }),
      ).toEqual({ envKey: "AWS_BEARER_TOKEN_BEDROCK", present: true });
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
