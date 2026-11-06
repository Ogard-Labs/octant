import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareConfinedReadinessProbe } from "./confinedReadinessProbe";
import type { ProcessConfinementPrepareInput } from "./seatbeltProfile";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("credential-readiness confinement", () => {
  it("keeps the account's status files readable without granting a project or the whole home", () => {
    const prepared: ProcessConfinementPrepareInput[] = [];
    const result = prepareConfinedReadinessProbe({
      family: "codex",
      binaryPath: "/opt/provider/bin/codex",
      args: ["login", "status"],
      environment: {
        HOME: "/Users/test",
        CODEX_HOME: "/Users/test/accounts/codex",
        PATH: "/usr/bin",
      },
      confinement: {
        prepare(input) {
          prepared.push(input);
          return { command: input.executable, args: input.args };
        },
      },
    });
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;
    try {
      expect(prepared[0]).toMatchObject({
        networkEgress: "none",
        readRoots: expect.arrayContaining([
          "/Users/test/accounts/codex/auth.json",
          "/Users/test/accounts/codex/config.toml",
        ]),
      });
      expect(prepared[0]?.readRoots).not.toContain("/Users/test");
      expect(prepared[0]?.additionalWriteRoots).toBeUndefined();
      expect(result.launch.environment.HOME).toBe("/Users/test");
      expect(result.launch.environment.TMPDIR).toBe(result.launch.workingDirectory);
    } finally {
      result.launch.release();
    }
  });

  it("refuses a credential-file link that would reopen the entire home", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-readiness-link-")));
    directories.push(root);
    mkdirSync(join(root, ".codex"));
    symlinkSync(root, join(root, ".codex", "auth.json"));
    expect(
      prepareConfinedReadinessProbe({
        family: "codex",
        binaryPath: "/opt/provider/bin/codex",
        args: ["login", "status"],
        environment: { HOME: root },
        confinement: {
          prepare() {
            throw new Error("must refuse before preparation");
          },
        },
      }),
    ).toMatchObject({ status: "refused", reason: "invalid-configuration" });
  });

  it("refuses an unavailable sandbox instead of starting the unconfined provider", () => {
    expect(
      prepareConfinedReadinessProbe({
        family: "claude",
        binaryPath: "/opt/provider/bin/claude",
        args: ["auth", "status", "--json"],
        environment: { HOME: "/Users/test" },
        confinement: {
          prepare() {
            throw new Error("sandbox unavailable");
          },
        },
      }),
    ).toMatchObject({ status: "refused", reason: "incompatible" });
  });
});
