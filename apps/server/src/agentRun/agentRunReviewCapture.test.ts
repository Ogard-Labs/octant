import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { GitMutationPort } from "../code/gitMutationPort";
import { GitObservationPort } from "../code/gitObservationPort";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { createAgentRunReviewCapture } from "./agentRunReviewCapture";
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "octant-child-review-"));
  directories.push(root);
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "file.txt"), "before\n");
  git("add", "file.txt");
  git("commit", "-m", "Initial content");
  const options = {
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    gitExecutable: "/usr/bin/git",
  };
  const capture = createAgentRunReviewCapture({
    mutation: new GitMutationPort(undefined, options),
    observation: new GitObservationPort(options),
  });
  const input = {
    checkoutRoot: root,
    runId: "11111111-1111-4111-8111-111111111111",
    executionPolicy: "approval-gated" as const,
    authorize: async () => true,
  };
  return { root, git, capture, input };
}
it("retains committed and untracked generation changes without changing the user's index or branch", async () => {
  const { root, git, capture, input } = setup();
  const first = await capture.begin(input, new AbortController().signal);
  expect(first).toBeDefined();
  expect(git("for-each-ref", "refs/octant/checkpoints")).toBe("");
  writeFileSync(join(root, "file.txt"), "first generation\n");
  git("add", "file.txt");
  git("commit", "-m", "Child change");
  writeFileSync(join(root, "new.txt"), "new file\n");
  const index = readFileSync(join(root, ".git/index"));
  const head = git("rev-parse", "HEAD");
  const one = await first?.finish(new AbortController().signal);
  expect(one?.diff).toContain("+first generation");
  expect(one?.diff).toContain("+new file");
  expect(one?.changedPaths).toEqual(["file.txt", "new.txt"]);
  expect(readFileSync(join(root, ".git/index"))).toEqual(index);
  expect(git("rev-parse", "HEAD")).toBe(head);
  const second = await capture.begin(input, new AbortController().signal);
  writeFileSync(join(root, "file.txt"), "second generation\n");
  const two = await second?.finish(new AbortController().signal);
  expect(two?.diff).toContain("-first generation");
  expect(two?.diff).toContain("+second generation");
  expect(one?.diff).not.toContain("second generation");
  if (one === undefined) throw new Error("Missing first comparison");
  const resumed = await capture.begin(
    { ...input, baseTree: one.baseTree },
    new AbortController().signal,
  );
  const cumulative = await resumed?.finish(new AbortController().signal);
  expect(cumulative?.diff).toContain("-before");
  expect(cumulative?.diff).toContain("+second generation");
  expect(cumulative?.diff).toContain("+new file");
  expect(git("for-each-ref", "refs/octant/checkpoints")).toBe("");
});
it("refuses Plan and revoked authority without pinning comparison content", async () => {
  const { git, capture, input } = setup();
  expect(
    await capture.begin({ ...input, executionPolicy: "plan" }, new AbortController().signal),
  ).toBeUndefined();
  expect(
    await capture.begin({ ...input, authorize: async () => false }, new AbortController().signal),
  ).toBeUndefined();
  let allowed = true;
  const lease = await capture.begin(
    { ...input, authorize: async () => allowed },
    new AbortController().signal,
  );
  allowed = false;
  expect(await lease?.finish(new AbortController().signal)).toBeUndefined();
  expect(git("for-each-ref", "refs/octant/checkpoints")).toBe("");
});
