import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCodeThreadId, decodeCodeCheckoutId } from "@octant/contracts";
import { AndroidRuntimeStore } from "./androidRuntimeStore";

const scope = {
  threadId: decodeCodeThreadId("10000000-0000-4000-8000-000000000001"),
  checkoutId: decodeCodeCheckoutId("10000000-0000-4000-8000-000000000002"),
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "octant-android-artifact-"));
  roots.push(root);
  return { root, store: new AndroidRuntimeStore(root) };
}

describe("Android artifact ownership", () => {
  it("retains task and checkout ownership across host restart", async () => {
    const { root, store } = await fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    await store.writeArtifact("android-screenshot-test", bytes, scope);
    const restarted = new AndroidRuntimeStore(root);
    expect(await restarted.readArtifact("android-screenshot-test", scope)).toEqual(bytes);
    expect(
      await restarted.readArtifact("android-screenshot-test", {
        ...scope,
        threadId: decodeCodeThreadId("10000000-0000-4000-8000-000000000003"),
      }),
    ).toBeUndefined();
    expect(
      await restarted.readArtifact("android-screenshot-test", {
        ...scope,
        checkoutId: decodeCodeCheckoutId("10000000-0000-4000-8000-000000000004"),
      }),
    ).toBeUndefined();
  });

  it("does not infer ownership for legacy unscoped files", async () => {
    const { store } = await fixture();
    await mkdir(store.artifactRoot, { recursive: true });
    await writeFile(join(store.artifactRoot, "android-screenshot-legacy"), "private");
    expect(await store.readArtifact("android-screenshot-legacy", scope)).toBeUndefined();
  });

  it("refuses a symlink in a scoped artifact path", async () => {
    const { root, store } = await fixture();
    const bytes = new Uint8Array([1]);
    await store.writeArtifact("android-screenshot-link", bytes, scope);
    const path = join(
      store.artifactRoot,
      scope.threadId,
      scope.checkoutId,
      "android-screenshot-link",
    );
    await mkdir(join(store.artifactRoot, scope.threadId, scope.checkoutId), { recursive: true });
    await rm(path, { force: true });
    const target = join(root, "private.txt");
    await writeFile(target, "private");
    await symlink(target, path);
    expect(await store.readArtifact("android-screenshot-link", scope)).toBeUndefined();
  });
});
