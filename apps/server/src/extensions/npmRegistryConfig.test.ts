import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseNpmRegistry, PUBLIC_NPM_REGISTRY, readUserNpmConfig } from "./npmRegistryConfig";

const userConfigText = [
  "; a comment",
  "//registry.example.test/:_authToken=never-read",
  "registry=https://registry.example.test/npm/",
  "@scoped:registry=https://scoped.example.test",
].join("\n");

describe("reading the person's npm configuration file", () => {
  const directories: Array<string> = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (directory) => {
        await chmod(join(directory, ".npmrc"), 0o600).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });
  const home = async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-npmrc-"));
    directories.push(directory);
    return directory;
  };

  it("reads the file, and treats a missing one as none", async () => {
    const directory = await home();
    expect(await readUserNpmConfig(directory, {})).toEqual({});
    await writeFile(join(directory, ".npmrc"), "registry=https://registry.example.test\n");
    expect(await readUserNpmConfig(directory, {})).toEqual({
      userConfigText: "registry=https://registry.example.test\n",
    });
  });

  it("says a file that exists but cannot be read is unreadable, not absent", async () => {
    const directory = await home();
    await writeFile(join(directory, ".npmrc"), "registry=https://private.example.test\n");
    await chmod(join(directory, ".npmrc"), 0o000);
    // A directory where the file should be cannot be read either, whoever runs this.
    const asDirectory = await home();
    await mkdir(join(asDirectory, ".npmrc"));

    expect(await readUserNpmConfig(asDirectory, {})).toEqual({ userConfigUnreadable: true });
    if (process.getuid?.() !== 0) {
      expect(await readUserNpmConfig(directory, {})).toEqual({ userConfigUnreadable: true });
    }
  });
});

describe("choosing the npm registry from the person's own configuration", () => {
  it("refuses when the configuration file could not be read, instead of falling back to the public registry", () => {
    expect(chooseNpmRegistry("demo", { env: {}, userConfigUnreadable: true })).toEqual({
      status: "unreadable",
    });
    expect(chooseNpmRegistry("@scoped/demo", { env: {}, userConfigUnreadable: true })).toEqual({
      status: "unreadable",
    });
    // An unscoped name is settled by the environment, which outranks the file.
    expect(
      chooseNpmRegistry("demo", {
        env: { npm_config_registry: "https://env.example.test" },
        userConfigUnreadable: true,
      }),
    ).toEqual({ status: "chosen", registry: "https://env.example.test" });
    // A scoped name may be mapped by the file, which cannot be consulted.
    expect(
      chooseNpmRegistry("@scoped/demo", {
        env: { npm_config_registry: "https://env.example.test" },
        userConfigUnreadable: true,
      }),
    ).toEqual({ status: "unreadable" });
  });

  it("uses the public registry when nothing names another", () => {
    expect(chooseNpmRegistry("demo", { env: {} })).toEqual({
      status: "chosen",
      registry: PUBLIC_NPM_REGISTRY,
    });
  });

  it("prefers the environment, then the scope's registry, then the default one", () => {
    expect(chooseNpmRegistry("demo", { env: {}, userConfigText })).toEqual({
      status: "chosen",
      registry: "https://registry.example.test/npm",
    });
    expect(chooseNpmRegistry("@scoped/demo", { env: {}, userConfigText })).toEqual({
      status: "chosen",
      registry: "https://scoped.example.test",
    });
    expect(
      chooseNpmRegistry("@scoped/demo", {
        env: { npm_config_registry: "https://env.example.test" },
        userConfigText,
      }),
    ).toEqual({ status: "chosen", registry: "https://env.example.test" });
  });

  it("refuses an address it cannot read or would reach insecurely instead of falling back", () => {
    const choose = (line: string) => chooseNpmRegistry("demo", { env: {}, userConfigText: line });
    expect(choose("registry=${PRIVATE_REGISTRY}")).toEqual({ status: "unreadable" });
    expect(choose("registry=ftp://x.test")).toEqual({ status: "unreadable" });
    expect(choose("registry=https://user:pw@x.test")).toEqual({ status: "unreadable" });
    expect(choose("registry=http://x.test")).toEqual({ status: "insecure" });
    expect(choose("registry=http://127.0.0.1:4873")).toEqual({
      status: "chosen",
      registry: "http://127.0.0.1:4873",
    });
  });
});
