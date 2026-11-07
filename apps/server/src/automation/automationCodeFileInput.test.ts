import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationFileArrivalReceipt, type AutomationRun } from "@octant/contracts";
import { Schema } from "effect";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import { automationDefinitionFixture, automationRunForDefinition } from "./automationTestFixtures";
import { prepareAutomationFileSource } from "./automationFileSourceScan";
import {
  automationSourceSnapshotDigest,
  initialAutomationFileCheckpoint,
} from "./automationFileSourceState";
import { prepareAutomationCodeFileInput } from "./automationCodeFileInput";
import { automationCodeInputDirectory } from "./automationFileContext";

const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const source = await realpath(await mkdtemp(join(tmpdir(), "octant-routine-source-")));
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "octant-routine-checkout-")));
  owned.push(source, checkout);
  await mkdir(join(source, "Inbox"));
  await writeFile(join(source, "Inbox", "report.txt"), "observed bytes");
  const definition = automationDefinitionFixture({
    trigger: {
      kind: "file-arrival",
      directory: "Inbox",
      includeExtensions: [],
      excludeDirectories: [],
      settleSeconds: 2,
      automaticStartLimit: 8,
    },
    nextDueAt: null,
  });
  if (definition.trigger.kind !== "file-arrival") throw new Error("Expected a file source");
  let allowed = true;
  const authority = {
    canonicalRoot: source,
    bindingIdentity: "exact-project-binding",
    current: () => allowed,
  };
  const root = await prepareAutomationFileSource({
    filesystem: liveWorkFilesystem,
    canonicalRoot: source,
    bindingIdentity: authority.bindingIdentity,
    trigger: definition.trigger,
    current: () => true,
    signal: new AbortController().signal,
  });
  const baseline = [
    {
      path: "report.txt",
      digest: createHash("sha256").update("observed bytes").digest("hex"),
      size: 14,
    },
  ];
  const receipt = Schema.decodeUnknownSync(AutomationFileArrivalReceipt)({
    files: ["report.txt"],
    automaticStartOrdinal: 1,
    checkpoint: {
      ...initialAutomationFileCheckpoint(root.sourceIdentity, definition.createdAt),
      baselineReady: true,
      baseline,
      baselineDigest: automationSourceSnapshotDigest(baseline),
      automaticStarts: 1,
      phase: "watching",
    },
  });
  const base = automationRunForDefinition(definition);
  const run: AutomationRun = {
    ...base,
    occurrence: {
      kind: "file-arrival",
      automationId: base.automationId,
      definitionRevision: definition.definitionRevision,
      source: receipt,
    },
  };
  const prepare = () =>
    prepareAutomationCodeFileInput({
      run,
      filesystem: liveWorkFilesystem,
      authority,
      checkoutRoot: checkout,
      current: () => allowed,
      signal: new AbortController().signal,
    });
  return {
    source,
    checkout,
    run,
    prepare,
    revoke: () => {
      allowed = false;
    },
  };
}

describe("Code routine file inputs", () => {
  it("copies exact observed bytes to the child checkout and recovers an identical partial copy", async () => {
    const f = await fixture();
    const current = await f.prepare();
    expect(current?.()).toBe(true);
    expect(
      await readFile(join(f.checkout, automationCodeInputDirectory(f.run), "report.txt"), "utf8"),
    ).toBe("observed bytes");
    expect((await f.prepare())?.()).toBe(true);
    f.revoke();
    expect(current?.()).toBe(false);
  });
  it("refuses a changed source instead of substituting its latest content", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "Inbox", "report.txt"), "replacement");
    expect(await f.prepare()).toBeUndefined();
    await expect(
      readFile(join(f.checkout, automationCodeInputDirectory(f.run), "report.txt")),
    ).rejects.toThrow();
  });
  it("never overwrites existing checkout inputs or follows a destination symlink", async () => {
    const f = await fixture();
    const directory = join(f.checkout, automationCodeInputDirectory(f.run));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "report.txt"), "person's edit");
    expect(await f.prepare()).toBeUndefined();
    expect(await readFile(join(directory, "report.txt"), "utf8")).toBe("person's edit");
    const second = await fixture();
    await symlink(second.source, join(second.checkout, "octant-routine-inputs"));
    expect(await second.prepare()).toBeUndefined();
  });
});
