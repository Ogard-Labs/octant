import {
  existsSync,
  statSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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
        readOnlyRoots: [],
        readWriteRoots: [join(base, "cache")],
        protectedPaths: [],
      },
      network: "existing-policy",
      credentials: "existing-policy",
      hostServices: "existing-policy",
    },
    context: {
      root: join(base, "project"),
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

  it("accepts unchanged folder identities recorded with native bigint stats", () => {
    const { input, selection } = fixture();
    // Container lower layers can use inode identities beyond Number's exact range.
    const folder = realpathSync(existsSync("/opt") ? "/opt" : input.boundRoot);
    const identities = [input.boundRoot, folder].map((path) => {
      const stat = statSync(path, { bigint: true });
      return { path, identity: `${stat.dev}:${stat.ino}` };
    });
    const compiled = compileSandboxLaunchPolicy(
      {
        ...input,
        sandboxPolicy: {
          ...selection,
          policy: {
            ...selection.policy,
            filesystem: { ...selection.policy.filesystem, readWriteRoots: [folder] },
          },
          context: { ...selection.context, rootIdentities: identities },
        },
      },
      "linux",
    );
    expect(compiled.status).toBe("admitted");
  });

  it("admits exact private state files without granting their containing folder", () => {
    const { base, input, selection } = fixture();
    const account = join(base, "account.json");
    const transcript = join(base, "new-transcript.jsonl");
    writeFileSync(account, "scoped state");
    const compiled = compileSandboxLaunchPolicy(
      {
        ...input,
        additionalWriteRoots: [account, transcript],
        sandboxPolicy: selection,
      },
      "linux",
    );
    expect(compiled).toMatchObject({
      status: "admitted",
      input: {
        additionalWriteRoots: [account, transcript, ...selection.policy.filesystem.readWriteRoots],
      },
    });
    expect(
      compileSandboxLaunchPolicy(
        {
          ...input,
          sandboxPolicy: {
            ...selection,
            policy: {
              ...selection.policy,
              filesystem: { ...selection.policy.filesystem, readWriteRoots: [account] },
            },
          },
        },
        "linux",
      ).status,
    ).toBe("refused");
    const dangling = join(base, "dangling");
    symlinkSync(join(base, "missing", "outside"), dangling);
    expect(
      compileSandboxLaunchPolicy(
        { ...input, additionalWriteRoots: [dangling], sandboxPolicy: selection },
        "linux",
      ).status,
    ).toBe("refused");
  });

  it("refuses writable folders inside host administration roots", () => {
    const { input, selection } = fixture();
    const result = compileSandboxLaunchPolicy(
      {
        ...input,
        sandboxPolicy: {
          ...selection,
          policy: {
            ...selection.policy,
            filesystem: {
              ...selection.policy.filesystem,
              readWriteRoots: [realpathSync("/usr/bin")],
            },
          },
        },
      },
      "linux",
    );
    expect(result).toMatchObject({ status: "refused", rules: ["filesystem.hostAdministration"] });
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
        rules: ["filesystem.protectedPaths", "credentials.isolated"],
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
        {
          ...input,
          additionalWriteRoots: [base],
          sandboxPolicy: {
            ...selection,
            policy: {
              ...selection.policy,
              filesystem: { ...selection.policy.filesystem, readOnlyRoots: [join(base, "shared")] },
            },
          },
        },
        "linux",
      ),
    ).toMatchObject({ status: "refused", code: "sandbox-policy-conflict" });
  });

  it("does not let a folder grant widen a read-only launch posture", () => {
    const { input, selection } = fixture();
    expect(
      compileSandboxLaunchPolicy(
        { ...input, writeBoundRoot: false, sandboxPolicy: selection },
        "linux",
      ),
    ).toMatchObject({
      status: "refused",
      code: "sandbox-policy-conflict",
      rules: ["filesystem.readOnlyPosture"],
    });
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
  it("refuses an administration root as a writable Project or folder grant", () => {
    const { input, selection } = fixture();
    expect(
      compileSandboxLaunchPolicy(
        {
          ...input,
          sandboxPolicy: {
            ...selection,
            policy: {
              ...selection.policy,
              filesystem: { ...selection.policy.filesystem, readWriteRoots: ["/etc"] },
            },
          },
        },
        "linux",
      ),
    ).toMatchObject({ status: "refused", rules: ["filesystem.hostAdministration"] });
  });
});
