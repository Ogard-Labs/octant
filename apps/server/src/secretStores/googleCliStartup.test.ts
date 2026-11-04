import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { makePersistenceLive } from "../persistence/persistenceService";
import { startOctantServer } from "../server";

describe("Google command resource recovery during host startup", () => {
  it.each(["recovered", "uncertain"] as const)(
    "waits for owned process recovery and keeps the host usable when recovery is %s",
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), "octant-google-startup-"));
      const previous = join(directory, "harness", "cloud-cli", "google-prior", "access-token");
      await mkdir(join(previous, ".."), { recursive: true });
      await writeFile(previous, "fixture-prior-token");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = RepositoryTestProcessPort.prototype.reconcile;
      const reconcile = vi
        .spyOn(RepositoryTestProcessPort.prototype, "reconcile")
        .mockImplementationOnce(async function (this: RepositoryTestProcessPort) {
          entered.resolve();
          await release.promise;
          if (outcome === "uncertain") throw new Error("Owned process recovery unavailable");
          return original.call(this);
        });
      const serve = vi.fn(() => ({
        url: new URL("http://127.0.0.1:13775"),
        stop: () => undefined,
      }));
      const started = Effect.runPromise(
        Effect.scoped(
          startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            extensionSkillRoots: { resolve: async () => [] },
            serve,
          }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
        ),
      );
      try {
        await entered.promise;
        expect(serve).not.toHaveBeenCalled();
        expect(await readFile(previous, "utf8")).toBe("fixture-prior-token");
        release.resolve();
        await started;
        expect(serve).toHaveBeenCalledOnce();
        if (outcome === "uncertain")
          expect(await readFile(previous, "utf8")).toBe("fixture-prior-token");
        else await expect(readFile(previous)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        release.resolve();
        await started.catch(() => undefined);
        reconcile.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
