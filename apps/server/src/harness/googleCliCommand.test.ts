import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeHarnessShell } from "./nativeHarnessShell";
import type { HarnessShellScriptInput } from "../code/repositoryTestProcessPort";
import type { RepositoryTestProcessResult } from "../code/repositoryTestRunner";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const result: RepositoryTestProcessResult = {
  termination: "exited",
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  parserFailed: false,
  cleanupUncertain: false,
};
describe("command-owned Google credential resources", () => {
  it("passes only the command's prepared token-file environment and config write root, then closes both resources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-google-command-"));
    directories.push(directory);
    const scripts = join(directory, "scripts");
    const config = join(directory, "configuration");
    await mkdir(scripts);
    await mkdir(config, { mode: 0o700 });
    const close = vi.fn(async () => {
      await rm(config, { recursive: true, force: true });
    });
    const prepare = vi.fn(async (commandDirectory: string) => {
      const tokenFile = join(commandDirectory, "google-access-token");
      await writeFile(tokenFile, "fixture-short-token", { mode: 0o600 });
      return {
        status: "ready" as const,
        beforeLaunch: () => true,
        environment: { CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: tokenFile, CLOUDSDK_CONFIG: config },
        configurationDirectory: config,
        close,
      };
    });
    const options = {
      scriptDirectory: scripts,
      googleCliCredentials: prepare,
      process: {
        executeShellScript: vi.fn(async (input: HarnessShellScriptInput) => {
          const path = input.environment.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE;
          expect(path).toBeTypeOf("string");
          if (path === undefined) throw new Error("Token-file environment missing");
          expect(await readFile(path, "utf8")).toBe("fixture-short-token");
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          expect(input.cloudCliConfigurationDirectory).toBe(config);
          expect(JSON.stringify(input)).not.toContain("fixture-short-token");
          return result;
        }),
      },
    };
    const shell = createNativeHarnessShell(options);
    await expect(
      shell.run({ command: "gcloud projects list", cwd: directory, timeoutMs: 1000 }),
    ).resolves.toMatchObject({ status: "ran" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(stat(config)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
