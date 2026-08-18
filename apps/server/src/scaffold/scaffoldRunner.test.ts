import { decodeCodeCheckoutId, decodeCodeThreadId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { CURATED_SCAFFOLDS } from "./curatedScaffoldCatalog";
import {
  ScaffoldRunner,
  type ScaffoldProcessResult,
  type ScaffoldRunnerOptions,
} from "./scaffoldRunner";

const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
const runId = "d0000000-0000-4000-8000-000000000001";

function entry(id: string) {
  const found = CURATED_SCAFFOLDS.find((candidate) => String(candidate.id) === id);
  if (found === undefined) throw new Error(`No curated scaffold ${id}.`);
  return found;
}

function runner(
  overrides: {
    readonly exists?: boolean;
    readonly tools?: ReadonlyArray<string>;
    readonly process?: ScaffoldProcessResult;
  } = {},
) {
  const times = ["2026-08-18T09:00:00.000Z", "2026-08-18T09:00:12.000Z"];
  const makeDirectory = vi.fn(async () => undefined);
  const execute = vi.fn(
    async (
      _input: Parameters<ScaffoldRunnerOptions["execute"]>[0],
    ): Promise<ScaffoldProcessResult> =>
      overrides.process ?? {
        termination: "exited",
        exitCode: 0,
        output: new TextEncoder().encode("Scaffolding project…\n"),
      },
  );
  return {
    execute,
    makeDirectory,
    scaffolds: new ScaffoldRunner({
      entryExists: async () => overrides.exists ?? false,
      makeDirectory,
      availableTools: async () => overrides.tools ?? ["bunx", "swift"],
      execute,
      now: () => times.shift() ?? "2026-08-18T09:00:12.000Z",
    }),
  };
}

function input(id: string, directoryName = "storefront") {
  return {
    runId,
    entry: entry(id),
    directoryName,
    threadId,
    checkoutId,
    executionPolicy: "approval-gated" as const,
    checkoutRoot: "/checkouts/project",
  };
}

describe("running a curated scaffold in a checkout", () => {
  it("runs the pinned generator in the checkout and reports what it created", async () => {
    const { scaffolds, execute, makeDirectory } = runner();

    const result = await scaffolds.run(input("web-app"));

    expect(execute.mock.calls[0]?.[0]).toEqual({
      argv: ["bunx", "--bun", "create-vite@9.1.2", "storefront", "--template", "react-ts"],
      cwd: "/checkouts/project",
      timeoutMs: 600_000,
    });
    // A package generator makes its own directory; the host must not race it.
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ran", run: { outcome: "created", exitCode: 0 } });
  });

  it("makes the directory first for a toolchain that initializes where it stands", async () => {
    const { scaffolds, execute, makeDirectory } = runner();

    await scaffolds.run(input("native-apple-app", "Widget"));

    expect(makeDirectory).toHaveBeenCalledWith({
      checkoutRoot: "/checkouts/project",
      name: "Widget",
    });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ cwd: "/checkouts/project/Widget" });
  });

  it("refuses without starting a process when the name is already taken", async () => {
    const { scaffolds, execute, makeDirectory } = runner({ exists: true });

    const result = await scaffolds.run(input("web-app"));

    expect(result).toEqual({
      status: "refused",
      message: "Something already exists at that name. Choose another.",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
  });

  it("refuses a scaffold whose tool this machine does not have", async () => {
    const { scaffolds, execute } = runner({ tools: ["bunx"] });

    const result = await scaffolds.run(input("native-apple-app", "Widget"));

    expect(result).toMatchObject({ status: "refused" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to write a project in Plan mode", async () => {
    const { scaffolds, execute } = runner();

    const result = await scaffolds.run({ ...input("web-app"), executionPolicy: "plan" });

    expect(result).toEqual({
      status: "refused",
      message: "Plan mode does not write files. Leave Plan mode to start a project.",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not call a generator that failed partway a created project", async () => {
    const { scaffolds } = runner({
      process: {
        termination: "exited",
        exitCode: 1,
        output: new TextEncoder().encode("network unreachable"),
      },
    });

    const result = await scaffolds.run(input("web-app"));

    expect(result).toMatchObject({ status: "ran", run: { outcome: "failed" } });
  });

  it("reports a generator that could not be started rather than throwing", async () => {
    const failing = new ScaffoldRunner({
      entryExists: async () => false,
      makeDirectory: async () => undefined,
      availableTools: async () => ["bunx"],
      execute: async () => {
        throw new Error("spawn ENOENT");
      },
      now: () => "2026-08-18T09:00:00.000Z",
    });
    const result = await failing.run(input("web-app"));

    expect(result).toMatchObject({
      status: "ran",
      run: { outcome: "unavailable", termination: "unavailable" },
    });
  });
});
