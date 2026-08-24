import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCredentialBrokerConfig,
  parseCodeFileHelperPath,
  parseDevelopmentWebBootstrap,
  parseDesktopBridgeSecret,
  parseServerLaunchConfig,
  parseHostServiceMode,
  parseServerInstanceId,
  parseServerPort,
} from "./serverConfig";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseDevelopmentWebBootstrap", () => {
  it("enables only the explicit development value", () => {
    expect(parseDevelopmentWebBootstrap(undefined)).toBeUndefined();
    expect(parseDevelopmentWebBootstrap("1")).toBe(true);
  });

  it.each(["", "0", "true", "yes"])("rejects an ambiguous value: %s", (value) => {
    expect(() => parseDevelopmentWebBootstrap(value)).toThrow(
      "OCTANT development web bootstrap is invalid",
    );
  });
});

describe("parseCodeFileHelperPath", () => {
  it("keeps an absolute managed helper path optional", () => {
    expect(parseCodeFileHelperPath(undefined)).toBeUndefined();
    expect(
      parseCodeFileHelperPath("/Applications/Octant.app/Contents/Resources/native/helper"),
    ).toBe("/Applications/Octant.app/Contents/Resources/native/helper");
  });

  it.each(["", "relative/helper", "./helper", "../helper"])(
    "rejects a non-absolute helper path without echoing it: %s",
    (helperPath) => {
      expect(() => parseCodeFileHelperPath(helperPath)).toThrow(
        "OCTANT_CODE_FILE_HELPER_PATH must be an absolute path",
      );
      try {
        parseCodeFileHelperPath(helperPath);
      } catch (error) {
        expect(String(error)).not.toContain(helperPath || "never-match-empty");
      }
    },
  );
});

describe("parseServerPort", () => {
  it("uses the Octant default and accepts a valid explicit port", () => {
    expect(parseServerPort(undefined)).toBe(13_773);
    expect(parseServerPort("4000")).toBe(4_000);
  });

  it.each(["0", "65536", "1.5", "not-a-port"])("rejects invalid port %s", (value) => {
    expect(() => parseServerPort(value)).toThrow(
      "OCTANT_SERVER_PORT must be an integer between 1 and 65535",
    );
  });
});

describe("parseDesktopBridgeSecret", () => {
  it("keeps a canonical 256-bit launch secret optional", () => {
    const secret = "A".repeat(43);
    expect(parseDesktopBridgeSecret(undefined)).toBeUndefined();
    expect(parseDesktopBridgeSecret(secret)).toBe(secret);
  });

  it.each(["", "short", "A".repeat(42), `${"A".repeat(42)}=`, `${"A".repeat(41)}+/`])(
    "rejects malformed launch secret without echoing it: %s",
    (secret) => {
      expect(() => parseDesktopBridgeSecret(secret)).toThrow("invalid");
      try {
        parseDesktopBridgeSecret(secret);
      } catch (error) {
        expect(String(error)).not.toContain(secret || "never-match-empty");
      }
    },
  );
});

describe("parseServerLaunchConfig", () => {
  it("resolves the host gh executable to a canonical absolute launch option", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-server-gh-"));
    directories.push(directory);
    const executable = join(directory, "gh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(executable, 0o700);

    expect(parseServerLaunchConfig({ PATH: directory })).toMatchObject({
      ghExecutable: realpathSync(executable),
    });
  });

  it("does not resolve packaged gh from a non-system PATH directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-packaged-gh-"));
    directories.push(directory);
    const executable = join(directory, "gh");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(executable, 0o700);

    expect(
      parseServerLaunchConfig({ OCTANT_PACKAGED_RUNTIME: "1", PATH: directory }),
    ).not.toHaveProperty("ghExecutable");
  });

  it("fails closed when a packaged runtime receives the development bootstrap flag", () => {
    expect(() =>
      parseServerLaunchConfig({
        OCTANT_PACKAGED_RUNTIME: "1",
        OCTANT_DEV_WEB_BOOTSTRAP: "1",
      }),
    ).toThrow("development web bootstrap is unavailable in packaged runtime");
  });

  it("also treats the packaged Electron Node marker as a release boundary", () => {
    expect(() =>
      parseServerLaunchConfig({
        ELECTRON_RUN_AS_NODE: "1",
        OCTANT_DEV_WEB_BOOTSTRAP: "1",
      }),
    ).toThrow("development web bootstrap is unavailable in packaged runtime");
  });

  it("propagates the launch-scoped desktop bridge secret into server startup options", () => {
    const secret = "A".repeat(43);

    expect(
      parseServerLaunchConfig({
        OCTANT_SERVER_PORT: "4000",
        OCTANT_SERVER_INSTANCE_ID: "11111111-1111-4111-8111-111111111111",
        OCTANT_DESKTOP_BRIDGE_SECRET: secret,
        OCTANT_CREDENTIAL_BROKER_TOKEN: "A".repeat(43),
        OCTANT_CREDENTIAL_BROKER_URL: "http://127.0.0.1:41000/",
        OCTANT_CODE_FILE_HELPER_PATH:
          "/Applications/Octant.app/Contents/Resources/native/octant-code-file-helper",
        OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1",
        OCTANT_HOST_SERVICE_MODE: "desktop",
      }),
    ).toEqual({
      port: 4_000,
      instanceId: "11111111-1111-4111-8111-111111111111",
      desktopBridgeSecret: secret,
      credentialBrokerToken: "A".repeat(43),
      credentialBrokerUrl: "http://127.0.0.1:41000/",
      codeFileHelperPath:
        "/Applications/Octant.app/Contents/Resources/native/octant-code-file-helper",
      packagedProviderSmokeControl: true,
      hostServiceMode: "desktop",
    });
  });

  it("enables packaged provider smoke control only for the exact harness flag", () => {
    expect(parseServerLaunchConfig({ OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "1" })).toMatchObject({
      packagedProviderSmokeControl: true,
    });
    expect(() =>
      parseServerLaunchConfig({ OCTANT_PACKAGED_PROVIDER_SMOKE_CONTROL: "true" }),
    ).toThrow("packaged provider smoke control is invalid");
  });

  it("omits optional launch authority when Electron did not provide it", () => {
    expect(parseServerLaunchConfig({})).toEqual({
      port: 13_773,
      hostServiceMode: "foreground",
    });
  });
});

describe("parseServerInstanceId", () => {
  it("keeps a canonical launch instance optional", () => {
    expect(parseServerInstanceId(undefined)).toBeUndefined();
    expect(parseServerInstanceId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it.each(["", "managed-instance", "11111111-1111-1111-1111-111111111111"])(
    "rejects a malformed launch instance without echoing it: %s",
    (instanceId) => {
      expect(() => parseServerInstanceId(instanceId)).toThrow("server instance id is invalid");
    },
  );
});

describe("parseHostServiceMode", () => {
  it("defaults to foreground and accepts exact entry-point modes", () => {
    expect(parseHostServiceMode(undefined)).toBe("foreground");
    expect(parseHostServiceMode("desktop")).toBe("desktop");
    expect(parseHostServiceMode("web")).toBe("web");
    expect(parseHostServiceMode("service")).toBe("service");
  });

  it.each(["", "run", "daemon", "FOREGROUND", "maintenance"])(
    "rejects an unrecognized launch mode: %s",
    (mode) => {
      expect(() => parseHostServiceMode(mode)).toThrow("host service mode is invalid");
    },
  );
});

describe("parseCredentialBrokerConfig", () => {
  it("keeps broker URL and launch token paired", () => {
    const token = "A".repeat(43);
    expect(parseCredentialBrokerConfig(undefined, undefined)).toBeUndefined();
    expect(parseCredentialBrokerConfig("http://127.0.0.1:41000/", token)).toEqual({
      url: "http://127.0.0.1:41000/",
      token,
    });
    expect(() => parseCredentialBrokerConfig("http://127.0.0.1:41000/", undefined)).toThrow(
      "must be configured together",
    );
    expect(() => parseCredentialBrokerConfig(undefined, token)).toThrow(
      "must be configured together",
    );
  });

  it.each([
    "https://127.0.0.1:41000/",
    "http://localhost:41000/",
    "http://127.0.0.1:41000/path",
    "http://127.0.0.1:41000/?debug=true",
    "http://user@127.0.0.1:41000/",
  ])("rejects an invalid broker URL without echoing it: %s", (url) => {
    const failure = (() => {
      try {
        parseCredentialBrokerConfig(url, "A".repeat(43));
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(url);
  });

  it("rejects a malformed token without echoing it", () => {
    const token = "private-malformed-token";
    expect(() => parseCredentialBrokerConfig("http://127.0.0.1:41000/", token)).toThrow("invalid");
    try {
      parseCredentialBrokerConfig("http://127.0.0.1:41000/", token);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });
});
