import { vi } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearBridgeSecretFile,
  clearHostInfoFile,
  readBridgeSecretFile,
  readHostInfoFile,
  resolveBridgeSecretFilePath,
  resolveHostInfoFilePath,
  writeBridgeSecretFile,
  writeHostInfoFile,
} from "./bridgeSecretFile";

const secret = `${"S".repeat(42)}A`;
const filesystemTestPlatform: NodeJS.Platform = process.platform === "darwin" ? "darwin" : "linux";

async function withTempDir<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "octant-bridge-secret-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("resolveBridgeSecretFilePath", () => {
  it("resolves under OCTANT_DATA_DIR when set", () => {
    const path = resolveBridgeSecretFilePath({
      env: { OCTANT_DATA_DIR: "/tmp/octant-test" },
      platform: "linux",
      home: "/home/user",
    });
    expect(path).toBe("/tmp/octant-test/octant-bridge-secret");
  });

  it("resolves under macOS Application Support when OCTANT_DATA_DIR is unset", () => {
    const path = resolveBridgeSecretFilePath({
      env: {},
      platform: "darwin",
      home: "/home/user",
    });
    expect(path).toBe("/home/user/Library/Application Support/Octant/octant-bridge-secret");
  });

  it("uses the Linux XDG data default without OCTANT_DATA_DIR", () => {
    expect(resolveBridgeSecretFilePath({ env: {}, platform: "linux", home: "/home/user" })).toBe(
      "/home/user/.local/share/octant/octant-bridge-secret",
    );
  });
});

describe("writeBridgeSecretFile / readBridgeSecretFile", () => {
  it("writes and reads the bridge secret with 0600 permissions", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      await writeBridgeSecretFile(input, secret);
      const path = resolveBridgeSecretFilePath(input);
      const fileStat = await stat(path);
      const mode = fileStat.mode & 0o777;
      expect(mode).toBe(0o600);
      const read = await readBridgeSecretFile(input);
      expect(read).toBe(secret);
    });
  });

  it("replaces a symlinked bridge-secret leaf without modifying its target", async () => {
    await withTempDir(async (directory) => {
      const dataDirectory = join(directory, "data");
      const target = join(directory, "do-not-overwrite");
      const input = {
        env: { OCTANT_DATA_DIR: dataDirectory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      await mkdir(dataDirectory, { mode: 0o700 });
      await writeFile(target, "preserve me", { mode: 0o600 });
      await symlink(target, resolveBridgeSecretFilePath(input));

      await writeBridgeSecretFile(input, secret);

      expect((await lstat(resolveBridgeSecretFilePath(input))).isFile()).toBe(true);
      expect(await readBridgeSecretFile(input)).toBe(secret);
      expect(await realpath(target)).toBe(target);
      expect(await readFile(target, "utf8")).toBe("preserve me");
    });
  });

  it("returns undefined when the bridge secret file does not exist", async () => {
    await withTempDir(async (directory) => {
      const read = await readBridgeSecretFile({
        env: { OCTANT_DATA_DIR: directory },
        platform: "linux",
        home: directory,
      });
      expect(read).toBeUndefined();
    });
  });

  it("returns undefined when the bridge secret file is empty", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      await writeBridgeSecretFile(input, "");
      const read = await readBridgeSecretFile(input);
      expect(read).toBeUndefined();
    });
  });

  it("clearBridgeSecretFile removes the file and is best-effort when absent", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      await writeBridgeSecretFile(input, secret);
      await clearBridgeSecretFile(input);
      expect(await readBridgeSecretFile(input)).toBeUndefined();
      await expect(clearBridgeSecretFile(input)).resolves.toBeUndefined();
    });
  });
});

describe("writeHostInfoFile / readHostInfoFile", () => {
  it("writes and reads the host info with 0600 permissions", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      const instanceId = "11111111-1111-4111-8111-111111111111";
      await writeHostInfoFile(input, { url: "http://127.0.0.1:13773", instanceId });
      const path = resolveHostInfoFilePath(input);
      const fileStat = await stat(path);
      expect(fileStat.mode & 0o777).toBe(0o600);
      const read = await readHostInfoFile(input);
      expect(read).toEqual({ url: "http://127.0.0.1:13773", instanceId });
    });
  });

  it("returns undefined when the host info file does not exist", async () => {
    await withTempDir(async (directory) => {
      const read = await readHostInfoFile({
        env: { OCTANT_DATA_DIR: directory },
        platform: "linux",
        home: directory,
      });
      expect(read).toBeUndefined();
    });
  });

  it("returns undefined when the host info file is malformed", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      await writeFile(resolveHostInfoFilePath(input), "not-json", { mode: 0o600 });
      expect(await readHostInfoFile(input)).toBeUndefined();
    });
  });

  it("never treats invalid versioned host info as legacy data", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      await writeFile(
        resolveHostInfoFilePath(input),
        JSON.stringify({
          schemaVersion: 2,
          hostId: "11111111-1111-4111-8111-111111111111",
          instanceId: "22222222-2222-4222-8222-222222222222",
          url: "http://example.com:13773/",
          controlEndpoint: "/tmp/octant.sock",
          serviceMode: "web",
          serverVersion: "2.0.0",
          wireVersion: "2",
          updatedAt: "2026-08-09T10:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      expect(await readHostInfoFile(input)).toBeUndefined();
    });
  });

  it("accepts only loopback URLs from a genuine legacy host-info shape", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      const path = resolveHostInfoFilePath(input);
      await writeFile(
        path,
        JSON.stringify({ url: "http://example.com:13773", instanceId: "old" }),
        {
          mode: 0o600,
        },
      );
      expect(await readHostInfoFile(input)).toBeUndefined();
      await writeFile(path, JSON.stringify({ url: "http://127.0.0.1:13773", instanceId: "old" }), {
        mode: 0o600,
      });
      expect(await readHostInfoFile(input)).toEqual({
        url: "http://127.0.0.1:13773",
        instanceId: "old",
      });
    });
  });

  it("clearHostInfoFile removes the file and is best-effort when absent", async () => {
    await withTempDir(async (directory) => {
      const input = {
        env: { OCTANT_DATA_DIR: directory },
        platform: filesystemTestPlatform,
        home: directory,
      };
      await writeHostInfoFile(input, {
        url: "http://127.0.0.1:13773",
        instanceId: "22222222-2222-4222-8222-222222222222",
      });
      await clearHostInfoFile(input);
      expect(await readHostInfoFile(input)).toBeUndefined();
      await expect(clearHostInfoFile(input)).resolves.toBeUndefined();
    });
  });
});
