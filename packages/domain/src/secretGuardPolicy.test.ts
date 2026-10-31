import { describe, expect, it } from "vitest";
import {
  NO_PROTECTED_FILES_CHANGES,
  SECRET_REDACTION,
  expandProtectedPath,
  protectedEntryDisplay,
  protectedEntryFor,
  protectedFileRefusal,
  redactSecrets,
  redactSecretsInValue,
  resolveProtectedFiles,
} from "./secretGuardPolicy";

const HOME = "/Users/person";
const darwin = {
  platform: "darwin" as const,
  home: HOME,
  dataDirectory: `${HOME}/Library/Application Support/Octant`,
  runtimeDirectory: "/private/tmp/octant-501",
};
const guarded = resolveProtectedFiles(darwin, NO_PROTECTED_FILES_CHANGES);
const covered = (path: string, own: ReadonlyArray<string> = []) =>
  protectedEntryFor([path], guarded, own)?.ruleId;

// Fake credentials built at run time, in the shapes the redaction must know.
const fake = {
  anthropic: `sk-ant-api03-${"a".repeat(24)}`,
  github: `gh${"p"}_${"b".repeat(32)}`,
  awsKeyId: `AKIA${"C".repeat(16)}`,
  npm: `npm_${"d".repeat(36)}`,
  privateKey: `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\nAAAA\n-----END OPENSSH ${"PRIVATE"} KEY-----`,
  urlPassword: `pass${"word".repeat(3)}`,
};

describe("secret guard list", () => {
  it("protects SSH private keys and leaves config, known_hosts, and public keys readable", () => {
    expect(covered(`${HOME}/.ssh/id_ed25519`)).toBe("ssh-private-keys");
    expect(covered(`${HOME}/.ssh/id_rsa`)).toBe("ssh-private-keys");
    expect(covered(`${HOME}/.ssh/id_work_github`)).toBe("ssh-private-keys");
    expect(covered(`${HOME}/.ssh/deploy.pem`)).toBe("ssh-private-keys");
    expect(covered(`${HOME}/.ssh/keys/id_ecdsa`)).toBe("ssh-private-keys");
    expect(covered(`${HOME}/.ssh/id_ed25519.pub`)).toBeUndefined();
    expect(covered(`${HOME}/.ssh/id_rsa-cert.pub`)).toBeUndefined();
    expect(covered(`${HOME}/.ssh/config`)).toBeUndefined();
    expect(covered(`${HOME}/.ssh/known_hosts`)).toBeUndefined();
    expect(covered(`${HOME}/.ssh/agent.sock`)).toBeUndefined();
  });

  it("protects cloud, registry, and Git credential files but not their configuration", () => {
    expect(covered(`${HOME}/.aws/credentials`)).toBe("cloud-credentials");
    expect(covered(`${HOME}/.aws/sso/cache/token.json`)).toBe("cloud-credentials");
    expect(covered(`${HOME}/.aws/config`)).toBeUndefined();
    expect(covered(`${HOME}/.kube/config`)).toBe("cluster-configuration");
    expect(covered(`${HOME}/.docker/config.json`)).toBe("container-registry-sign-in");
    expect(covered(`${HOME}/.npmrc`)).toBe("package-registry-tokens");
    expect(covered(`${HOME}/.git-credentials`)).toBe("git-credential-files");
    expect(covered(`${HOME}/.netrc`)).toBe("git-credential-files");
    expect(covered(`${HOME}/.config/gh/hosts.yml`)).toBe("forge-cli-sign-in");
    expect(covered(`${HOME}/.gitconfig`)).toBeUndefined();
  });

  it("keeps the login keychain reachable for the keychain service and protects every other keychain file", () => {
    expect(covered(`${HOME}/Library/Keychains/login.keychain-db`)).toBeUndefined();
    expect(covered(`${HOME}/Library/Keychains/login.keychain-db-wal`)).toBeUndefined();
    expect(covered(`${HOME}/Library/Keychains/other.keychain-db`)).toBe("keychains-and-vaults");
    expect(covered(`${HOME}/Library/Keychains/ABCD-1234/keychain-2.db`)).toBe(
      "keychains-and-vaults",
    );
  });

  it("protects browser cookie and login stores in any profile", () => {
    const support = `${HOME}/Library/Application Support`;
    expect(covered(`${support}/Google/Chrome/Default/Cookies`)).toBe("browser-cookies-and-logins");
    expect(covered(`${support}/Google/Chrome/Profile 2/Login Data`)).toBe(
      "browser-cookies-and-logins",
    );
    expect(covered(`${support}/Firefox/Profiles/x.default/logins.json`)).toBe(
      "browser-cookies-and-logins",
    );
    expect(covered(`${support}/Google/Chrome/Default/Preferences`)).toBeUndefined();
  });

  it("lets a runtime read its own sign-in and no other tool's", () => {
    const codexHome = `${HOME}/.codex`;
    expect(covered(`${HOME}/.codex/auth.json`)).toBe("provider-sign-ins");
    expect(covered(`${HOME}/.codex/auth.json`, [codexHome])).toBeUndefined();
    expect(covered(`${HOME}/.claude/.credentials.json`, [codexHome])).toBe("provider-sign-ins");
    const account = `${darwin.dataDirectory}/providers/codex/account-a`;
    expect(covered(`${account}/auth.json`, [account])).toBeUndefined();
    expect(covered(`${darwin.dataDirectory}/providers/codex/account-b/auth.json`, [account])).toBe(
      "provider-sign-ins",
    );
    // An own path never opens an SSH key or a cloud credential.
    expect(covered(`${HOME}/.ssh/id_rsa`, [HOME])).toBe("ssh-private-keys");
  });

  it("protects Octant's own secrets", () => {
    expect(covered(`${darwin.dataDirectory}/octant-bridge-secret`)).toBe("octant-credentials");
    expect(covered(`${darwin.runtimeDirectory}/host.secret`)).toBe("octant-credentials");
    expect(covered(`${darwin.dataDirectory}/octant.sqlite3`)).toBeUndefined();
  });

  it("drops a removed built-in group and adds the person's own paths", () => {
    const entries = resolveProtectedFiles(darwin, {
      added: ["~/secrets", "/opt/vault/token"],
      removed: ["cluster-configuration"],
    });
    expect(protectedEntryFor([`${HOME}/.kube/config`], entries)).toBeUndefined();
    expect(protectedEntryFor([`${HOME}/secrets/a.txt`], entries)?.ruleId).toBe("added");
    expect(protectedEntryFor(["/opt/vault/token"], entries)?.ruleId).toBe("added");
  });

  it("catches a link into a protected folder by its resolved form", () => {
    expect(
      protectedEntryFor([`${HOME}/project/key-link`, `${HOME}/.ssh/id_rsa`], guarded)?.ruleId,
    ).toBe("ssh-private-keys");
  });

  it("uses the Linux locations on Linux", () => {
    const linux = resolveProtectedFiles(
      { platform: "linux", home: "/home/person" },
      NO_PROTECTED_FILES_CHANGES,
    );
    expect(
      protectedEntryFor(["/home/person/.local/share/keyrings/login.keyring"], linux)?.ruleId,
    ).toBe("keychains-and-vaults");
    expect(
      protectedEntryFor(["/home/person/.config/google-chrome/Default/Cookies"], linux)?.ruleId,
    ).toBe("browser-cookies-and-logins");
  });

  it("refuses to expand a relative or root path", () => {
    expect(expandProtectedPath("~/x/", HOME)).toBe(`${HOME}/x`);
    expect(expandProtectedPath("relative", HOME)).toBeUndefined();
    expect(expandProtectedPath("/", HOME)).toBeUndefined();
  });
});

describe("secret guard refusal", () => {
  it("names the rule that refused and the channel to use instead", () => {
    const entry = protectedEntryFor([`${HOME}/.ssh/id_ed25519`], guarded);
    if (entry === undefined) throw new Error("expected the SSH key to be protected");
    const message = protectedFileRefusal(entry, HOME);
    expect(message).toContain("~/.ssh/id_* (not .pub)");
    expect(message).toContain("SSH private keys");
    expect(message).toContain("SSH agent");
    expect(message).toContain("Settings › Permissions › Protected files");
    expect(protectedEntryDisplay(entry, HOME)).toBe("~/.ssh/id_* (not .pub)");
  });
});

describe("secret redaction", () => {
  it("redacts known key formats wherever they appear", () => {
    const text = [
      `key ${fake.anthropic}`,
      `token ${fake.github}`,
      `aws ${fake.awsKeyId}`,
      `//registry.npmjs.org/:_authToken=${fake.npm}`,
      fake.privateKey,
      `https://user:${fake.urlPassword}@example.com/repo.git`,
    ].join("\n");
    const result = redactSecrets(text);
    expect(result.redacted).toBe(true);
    for (const leaked of Object.values(fake)) expect(result.text).not.toContain(leaked);
    expect(result.text).toContain(SECRET_REDACTION);
    expect(result.text).toContain("https://user:");
  });

  it("redacts a value the broker handed out even when it has no known shape", () => {
    expect(redactSecrets("export TOKEN=opaque-value-123", ["opaque-value-123"]).text).toBe(
      `export TOKEN=${SECRET_REDACTION}`,
    );
    expect(redactSecrets("short abc", ["abc"]).redacted).toBe(false);
  });

  it("leaves ordinary text alone and keeps unchanged values identical", () => {
    const value = { a: "ordinary output", list: ["git push origin main"] };
    expect(redactSecretsInValue(value)).toBe(value);
    expect(redactSecretsInValue({ output: fake.github })).toEqual({ output: SECRET_REDACTION });
  });
});
