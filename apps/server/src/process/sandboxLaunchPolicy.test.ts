import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { compileSandboxLaunchPolicy } from "./sandboxLaunchPolicy";
import { ownAccountRoots, type ProcessConfinementPrepareInput } from "./seatbeltProfile";
import { buildBubblewrapLaunch } from "./linuxConfinement";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-sandbox-policy-")));
  directories.push(base);
  for (const name of ["project", "shared", "scratch", "cache"]) mkdirSync(join(base, name));
  const selection = decodeSandboxPolicySelection({
    policy: {
      schemaVersion: 1,
      revision: 1,
      filesystem: {
        readOnlyRoots: [join(base, "shared")],
        readWriteRoots: [join(base, "cache")],
        protectedPaths: [],
      },
      network: "existing-policy",
      credentials: "existing-policy",
      hostServices: "existing-policy",
    },
    context: {
      hostId: "host",
      projectId: "20000000-0000-4000-8000-000000000001",
      checkoutId: "checkout",
      sessionId: "epoch:session",
      provider: "native-harness",
    },
  });
  const input: ProcessConfinementPrepareInput = {
    executable: "/bin/sh",
    args: ["-c", "true"],
    boundRoot: join(base, "project"),
    temporaryDirectory: join(base, "scratch"),
    networkEgress: "none",
  };
  return { base, input, selection };
}

describe("sandbox launch policy", () => {
  it("leaves every legacy launch unchanged when no policy is selected", () => {
    const { input } = fixture();
    expect(compileSandboxLaunchPolicy(input, "linux")).toEqual({ status: "legacy", input });
  });

  it("admits explicit folders and binds its receipt to the whole process authority", () => {
    const { input, selection } = fixture();
    const compile = (selected: unknown = selection, launch = input) =>
      compileSandboxLaunchPolicy({ ...launch, sandboxPolicy: selected }, "linux");
    const result = compile();
    expect(result).toMatchObject({
      status: "admitted",
      input: {
        readRoots: selection.policy.filesystem.readOnlyRoots,
        additionalWriteRoots: selection.policy.filesystem.readWriteRoots,
      },
    });
    if (result.status !== "admitted") throw new Error("Expected admission");
    expect(compile()).toEqual(result);
    for (const changed of [
      { ...selection, policy: { ...selection.policy, revision: 2 } },
      { ...selection, context: { ...selection.context, sessionId: "new-epoch:session" } },
      {
        ...selection,
        context: { ...selection.context, projectId: "20000000-0000-4000-8000-000000000002" },
      },
      { ...selection, context: { ...selection.context, provider: "another-provider" } },
    ]) {
      const next = compile(changed);
      expect(next.status).toBe("admitted");
      expect(next.status === "admitted" && next.receipt.reuseKey).not.toBe(result.receipt.reuseKey);
    }
    const changedLaunch = compile(selection, { ...input, allowProcessExec: false });
    expect(changedLaunch.status).toBe("admitted");
    expect(changedLaunch.status === "admitted" && changedLaunch.receipt.reuseKey).not.toBe(
      result.receipt.reuseKey,
    );
  });

  it("keeps folder grants separate from provider sign-in exemptions", () => {
    const { base, input, selection } = fixture();
    const account = join(base, "own-account");
    mkdirSync(account);
    const compiled = compileSandboxLaunchPolicy(
      { ...input, readRoots: [account], sandboxPolicy: selection },
      "linux",
    );
    expect(compiled.status).toBe("admitted");
    if (compiled.status !== "admitted") throw new Error("Expected admission");
    expect(
      ownAccountRoots(
        compiled.input,
        compiled.input.readRoots ?? [],
        compiled.input.additionalWriteRoots ?? [],
      ),
    ).toEqual([account]);
  });

  it("refuses bypassing admission through the Linux backend", () => {
    const { input, selection } = fixture();
    expect(() => buildBubblewrapLaunch({ ...input, sandboxPolicy: selection })).toThrow(
      "must be admitted through the shared confinement port",
    );
  });

  it("refuses unsupported protection before materializing a weaker launch", () => {
    const { input, selection } = fixture();
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        compileSandboxLaunchPolicy(
          {
            ...input,
            sandboxPolicy: {
              ...selection,
              policy: {
                ...selection.policy,
                hostServices: "blocked",
                credentials: "isolated",
                filesystem: {
                  ...selection.policy.filesystem,
                  protectedPaths: [{ path: join(input.boundRoot, "late-secret"), mode: "deny" }],
                },
              },
            },
          },
          platform,
        ),
      ).toMatchObject({
        status: "refused",
        code: "sandbox-policy-unsupported",
        rules: ["filesystem.protectedPaths", "credentials.isolated", "hostServices.blocked"],
      });
    }
    expect(
      compileSandboxLaunchPolicy({ ...input, sandboxPolicy: selection }, "win32"),
    ).toMatchObject({ status: "refused", code: "sandbox-policy-unsupported" });
  });

  it("refuses a read-only folder with a writable alias or ancestor", () => {
    const { base, input, selection } = fixture();
    symlinkSync(input.boundRoot, join(base, "alias"));
    for (const path of [input.boundRoot, base, join(base, "alias"), input.temporaryDirectory]) {
      expect(
        compileSandboxLaunchPolicy(
          {
            ...input,
            sandboxPolicy: {
              ...selection,
              policy: {
                ...selection.policy,
                filesystem: { ...selection.policy.filesystem, readOnlyRoots: [path] },
              },
            },
          },
          "linux",
        ),
      ).toMatchObject({ status: "refused", code: "sandbox-policy-conflict" });
    }
    expect(
      compileSandboxLaunchPolicy(
        { ...input, additionalWriteRoots: [base], sandboxPolicy: selection },
        "linux",
      ),
    ).toMatchObject({ status: "refused", code: "sandbox-policy-conflict" });
  });

  it("refuses caller-supplied materialized roots without a policy admission", () => {
    const { input } = fixture();
    expect(
      compileSandboxLaunchPolicy({ ...input, policyReadOnlyRoots: [input.boundRoot] }, "linux"),
    ).toMatchObject({ status: "refused", code: "sandbox-policy-malformed" });
  });

  it("refuses unavailable grants and malformed policies instead of ignoring them", () => {
    const { base, input, selection } = fixture();
    expect(
      compileSandboxLaunchPolicy(
        {
          ...input,
          sandboxPolicy: {
            ...selection,
            policy: {
              ...selection.policy,
              filesystem: {
                ...selection.policy.filesystem,
                readOnlyRoots: [join(base, "missing")],
              },
            },
          },
        },
        "linux",
      ),
    ).toMatchObject({ status: "refused", code: "sandbox-policy-unavailable" });
    const invalid = {
      ...input,
      sandboxPolicy: { ...selection, policy: { ...selection.policy, schemaVersion: 2 } },
    };
    expect(compileSandboxLaunchPolicy(invalid, "linux")).toMatchObject({
      status: "refused",
      code: "sandbox-policy-malformed",
    });
  });
});
