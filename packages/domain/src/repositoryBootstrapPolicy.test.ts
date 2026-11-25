import { describe, expect, it } from "vitest";
import {
  classifyBootstrapCloneStderr,
  defaultBootstrapFolderName,
  deriveBootstrapCloneRemotes,
  isBootstrapSensitiveIgnoredPath,
  isOsJunkIgnoredFile,
  validateBootstrapCloneUrl,
  validateBootstrapDestinationInput,
  validateBootstrapRelativePath,
} from "./repositoryBootstrapPolicy";

describe("repository bootstrap policy", () => {
  it("derives SSH and HTTPS URLs from both SCP-style SSH and HTTPS origin remotes", () => {
    const fromScp = deriveBootstrapCloneRemotes("git@github.com:org/my-app.git");
    expect(fromScp.repositoryName).toBe("my-app");
    expect(fromScp.remotes).toEqual({
      originUrl: "git@github.com:org/my-app.git",
      sshUrl: "git@github.com:org/my-app.git",
      httpsUrl: "https://github.com/org/my-app.git",
      defaultTransport: "ssh",
    });

    const fromHttps = deriveBootstrapCloneRemotes("https://gitlab.example.com/group/sub/repo.git");
    expect(fromHttps.repositoryName).toBe("repo");
    expect(fromHttps.remotes).toEqual({
      originUrl: "https://gitlab.example.com/group/sub/repo.git",
      httpsUrl: "https://gitlab.example.com/group/sub/repo.git",
      sshUrl: "git@gitlab.example.com:group/sub/repo.git",
      defaultTransport: "https",
    });

    const fromAbsoluteScp = deriveBootstrapCloneRemotes("git@git.example.com:/srv/git/demo.git");
    expect(fromAbsoluteScp.repositoryName).toBe("demo");
    expect(fromAbsoluteScp.remotes).toEqual({
      originUrl: "git@git.example.com:/srv/git/demo.git",
      sshUrl: "git@git.example.com:/srv/git/demo.git",
      httpsUrl: "https://git.example.com/srv/git/demo.git",
      defaultTransport: "ssh",
    });
    expect(validateBootstrapCloneUrl("git@git.example.com:/srv/git/demo.git", "ssh")).toEqual({
      ok: true,
      normalizedUrl: "git@git.example.com:/srv/git/demo.git",
    });
    expect(validateBootstrapCloneUrl("git@github.com:org/my-app.git", "ssh")).toEqual({
      ok: true,
      normalizedUrl: "git@github.com:org/my-app.git",
    });

    const fromSshSchemeCustomPort = deriveBootstrapCloneRemotes(
      "ssh://git@git.internal:2222/team/tool.git",
    );
    expect(fromSshSchemeCustomPort.remotes.sshUrl).toBe(
      "ssh://git@git.internal:2222/team/tool.git",
    );
    expect(fromSshSchemeCustomPort.remotes.httpsUrl).toBeUndefined();
    expect(fromSshSchemeCustomPort.remotes.defaultTransport).toBe("ssh");
  });

  it("refuses unsafe remote schemes, option injection, and embedded HTTPS credentials", () => {
    for (const unsafe of [
      "file:///tmp/repo",
      "ext::sh -c id",
      "http://github.com/org/repo.git",
      "git://github.com/org/repo.git",
      "-u./payload",
      "https://token@github.com/org/repo.git",
      "git@github.com:org/../escape.git",
    ]) {
      const derived = deriveBootstrapCloneRemotes(unsafe);
      expect(derived.remotes.sshUrl).toBeUndefined();
      expect(derived.remotes.httpsUrl).toBeUndefined();
      expect(derived.remotes.unavailableReason).toBeTruthy();

      expect(validateBootstrapCloneUrl(unsafe, "ssh").ok).toBe(false);
      expect(validateBootstrapCloneUrl(unsafe, "https").ok).toBe(false);
    }
  });

  it("excludes OS metadata junk files and flags secret-sensitive ignored paths", () => {
    expect(isOsJunkIgnoredFile(".DS_Store")).toBe(true);
    expect(isOsJunkIgnoredFile("apps/web/.DS_Store")).toBe(true);
    expect(isOsJunkIgnoredFile("._env")).toBe(true);
    expect(isOsJunkIgnoredFile("Thumbs.db")).toBe(true);
    expect(isOsJunkIgnoredFile("desktop.ini")).toBe(true);
    expect(isOsJunkIgnoredFile(".env")).toBe(false);
    expect(isOsJunkIgnoredFile("apps/web/.env.local")).toBe(false);

    expect(isBootstrapSensitiveIgnoredPath(".env")).toBe(true);
    expect(isBootstrapSensitiveIgnoredPath("apps/web/.env.local")).toBe(true);
    expect(isBootstrapSensitiveIgnoredPath("certs/dev.pem")).toBe(true);
    expect(isBootstrapSensitiveIgnoredPath(".npmrc")).toBe(true);
    expect(isBootstrapSensitiveIgnoredPath(".env.example")).toBe(false);
    expect(isBootstrapSensitiveIgnoredPath("local.settings.json")).toBe(false);
  });

  it("rejects traversal, absolute paths, and .git internals in ignored file paths", () => {
    expect(validateBootstrapRelativePath("apps/web/.env.local")).toEqual({
      ok: true,
      normalized: "apps/web/.env.local",
      segments: ["apps", "web", ".env.local"],
    });
    expect(validateBootstrapRelativePath("../outside")).toMatchObject({
      ok: false,
      reason: "invalid-path",
    });
    expect(validateBootstrapRelativePath("/etc/passwd")).toMatchObject({
      ok: false,
      reason: "invalid-path",
    });
    expect(validateBootstrapRelativePath(".git/config")).toMatchObject({
      ok: false,
      reason: "git-internal-refused",
    });
    expect(validateBootstrapRelativePath("sub/.GIT/hooks/post-checkout")).toMatchObject({
      ok: false,
      reason: "git-internal-refused",
    });
  });

  it("validates destination paths and classifies SSH and HTTPS clone failures", () => {
    expect(validateBootstrapDestinationInput("~/octant")).toEqual({
      ok: true,
      trimmed: "~/octant",
    });
    expect(validateBootstrapDestinationInput("/Users/dev/repos/octant").ok).toBe(true);
    expect(validateBootstrapDestinationInput("~/../etc").ok).toBe(false);
    expect(validateBootstrapDestinationInput("~").ok).toBe(false);
    expect(validateBootstrapDestinationInput("-flag").ok).toBe(false);
    expect(
      validateBootstrapDestinationInput("C:\\Users\\dev\\src\\demo", { platform: "win32" }),
    ).toEqual({ ok: true, trimmed: "C:\\Users\\dev\\src\\demo" });
    expect(validateBootstrapDestinationInput("~\\src\\demo", { platform: "win32" }).ok).toBe(true);
    expect(
      validateBootstrapDestinationInput("C:\\Users\\dev\\..\\secret", { platform: "win32" }).ok,
    ).toBe(false);
    expect(validateBootstrapDestinationInput("C:\\", { platform: "win32" }).ok).toBe(false);
    expect(
      validateBootstrapDestinationInput("\\\\server\\share\\repo", { platform: "win32" }).ok,
    ).toBe(false);

    expect(
      classifyBootstrapCloneStderr(
        "Host key verification failed.\nfatal: Could not read from remote repository.",
        "ssh",
      ),
    ).toBe("host-key-unverified");
    expect(
      classifyBootstrapCloneStderr("git@github.com: Permission denied (publickey).", "ssh"),
    ).toBe("auth-failed");
    expect(
      classifyBootstrapCloneStderr(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "https",
      ),
    ).toBe("auth-failed");
    expect(classifyBootstrapCloneStderr("fatal: repository not found", "https")).toBe(
      "clone-failed",
    );
    expect(defaultBootstrapFolderName("my-repo.git", "Fallback")).toBe("my-repo");
  });
});
