import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAutomationRun, decodeAutomationThreadId } from "@octant/contracts";
import {
  persistProcessReceipt,
  readOwnedProcessReceipts,
} from "../process/nodeOwnedProcessReceipt";
import { automationDefinitionFixture, automationRunForDefinition } from "./automationTestFixtures";
import {
  readAutomationFileSourceActivity,
  type AutomationFileActivityPorts,
} from "./automationFileSourceActivity";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const queued = automationRunForDefinition(automationDefinitionFixture());
const terminal = decodeAutomationRun({
  ...queued,
  lifecycle: "failed",
  failure: { reason: "runtime-failed", message: "First turn finished." },
  threadId: decodeAutomationThreadId("11111111-1111-4111-8111-111111111111"),
});
const ports: AutomationFileActivityPorts = {
  readRun: () => terminal,
  readChildren: () => [],
  readProcessReceipts: async () => [],
};
const request = {
  canonicalRoot: "/project",
  activityWindow: [terminal.id],
  activeRun: undefined,
  ports,
};

describe("file source known activity window", () => {
  it("keeps the source busy for a managed descendant after the routine's first turn is terminal", async () => {
    expect(
      await readAutomationFileSourceActivity({
        ...request,
        ports: { ...ports, readChildren: () => [{ lifecycleStatus: "running" }] },
      }),
    ).toBe("busy");
    expect(await readAutomationFileSourceActivity(request)).toBe("quiet");
  });
  it("retains an unknown owner instead of treating a missing run or failed child observation as quiet", async () => {
    expect(
      await readAutomationFileSourceActivity({
        ...request,
        ports: { ...ports, readRun: () => undefined },
      }),
    ).toBe("unknown");
    expect(
      await readAutomationFileSourceActivity({
        ...request,
        ports: {
          ...ports,
          readChildren: () => {
            throw new Error("Unavailable");
          },
        },
      }),
    ).toBe("unknown");
  });
  it("holds for the actual existing Project-root process receipt until the existing owner removes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-arrival-receipts-"));
    directories.push(directory);
    const options = {
      receiptDirectory: directory,
      supervisor: "repository-test-runner",
      processIdentity: async () => `sha256:${"b".repeat(64)}`,
    };
    const receipt = await persistProcessReceipt(
      options,
      '/project/subdir:["fake-command"]:1234',
      1234,
    );
    await receipt.ready;
    const observed: AutomationFileActivityPorts = {
      ...ports,
      readProcessReceipts: async () =>
        (await readOwnedProcessReceipts(options)).map((row) => row.receipt),
    };
    expect(await readAutomationFileSourceActivity({ ...request, ports: observed })).toBe("busy");
    expect(
      await readAutomationFileSourceActivity({
        ...request,
        canonicalRoot: "/other-project",
        ports: observed,
      }),
    ).toBe("quiet");
    await receipt.remove();
    expect(await readAutomationFileSourceActivity({ ...request, ports: observed })).toBe("quiet");
  });
  it("does not treat malformed persisted process ownership as quiescence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-arrival-malformed-"));
    directories.push(directory);
    await writeFile(join(directory, `receipt-${"a".repeat(64)}.json`), "{}");
    expect(
      await readAutomationFileSourceActivity({
        ...request,
        ports: {
          ...ports,
          readProcessReceipts: async () =>
            (
              await readOwnedProcessReceipts({
                receiptDirectory: directory,
                supervisor: "repository-test-runner",
              })
            ).map((row) => row.receipt),
        },
      }),
    ).toBe("unknown");
  });
  it("does not need descendant/process absence to know a queued accepted routine is busy", async () => {
    expect(await readAutomationFileSourceActivity({ ...request, activeRun: queued })).toBe("busy");
  });
});
