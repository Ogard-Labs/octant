import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { decodeAppReleaseRing, type AppUpdateState } from "@octant/contracts/app-updates";
import type { NightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { DESKTOP_FLAVOR_IDENTITIES } from "@octant/host-runtime";
import { resolveUpdateInstallReadiness } from "@octant/domain";
import { createAppUpdateService, type AppUpdateServiceOptions } from "./appUpdateService";
import { probeLocalHost } from "./localHostProbe";

const NIGHTLY_RINGS = DESKTOP_FLAVOR_IDENTITIES.nightly.rings;
type Preferences = { readonly ring: "preview"; readonly automaticChecks: boolean };
const defaults: Preferences = {
  ring: DESKTOP_FLAVOR_IDENTITIES.nightly.defaultRing,
  automaticChecks: false,
};

async function readPreferences(path: string): Promise<Preferences> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      const bytes = Buffer.alloc(4_097);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 4_096) return defaults;
      raw = bytes.subarray(0, read.bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("ring" in value) ||
      (value.ring !== "preview" && value.ring !== "candidate") ||
      !("automaticChecks" in value) ||
      typeof value.automaticChecks !== "boolean"
    )
      return defaults;
    // Nightly once also offered `candidate`; that ring now belongs to Octant's
    // Preview channel, so a choice stored then keeps its automatic-check
    // setting but follows Nightly's one ring.
    return { ring: "preview", automaticChecks: value.automaticChecks };
  } catch {
    return defaults;
  }
}

/** Nightly preferences and apply never acquire ownership of Stable's host. */
export async function createNightlyAppUpdates(options: {
  readonly userDataDirectory: string;
  readonly service: Omit<AppUpdateServiceOptions, "ring" | "allowedRings" | "automaticChecks">;
  readonly prepare: () => Promise<{ readonly kind: "closed" | "failed" }>;
  readonly canApply: () => boolean;
  readonly recover: (message: string) => Promise<void>;
  readonly fetchActivity?: typeof globalThis.fetch;
}) {
  const path = join(options.userDataDirectory, "update-preferences.json");
  let preferences = await readPreferences(path);
  const updates = createAppUpdateService({
    ...options.service,
    ring: preferences.ring,
    allowedRings: NIGHTLY_RINGS,
    automaticChecks: false,
  });
  if (preferences.automaticChecks) updates.setAutomaticChecks(true);
  let writes: Promise<AppUpdateState> = Promise.resolve(updates.state());
  let applying = false;
  let disposed = false;
  const failed = (message: string): AppUpdateState => ({
    ...updates.state(),
    status: "failed",
    message,
  });
  const persist = (change: Partial<Preferences>) => {
    const run = async () => {
      const next = { ...preferences, ...change };
      const temporary = join(options.userDataDirectory, `.update-preferences-${randomUUID()}.json`);
      try {
        await mkdir(options.userDataDirectory, { recursive: true });
        await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } catch {
        await unlink(temporary).catch(() => undefined);
        return failed(
          "Nightly could not save its update preference. The previous choice is unchanged.",
        );
      }
      preferences = next;
      if (disposed) return updates.state();
      updates.setRing(next.ring);
      return updates.setAutomaticChecks(next.automaticChecks);
    };
    writes = writes.then(run, run);
    return writes;
  };
  return Object.freeze({
    state: updates.state,
    check: updates.check,
    download: updates.download,
    dispose: () => {
      disposed = true;
      updates.dispose();
    },
    setRing: (value: unknown): Promise<AppUpdateState> => {
      const ring = decodeAppReleaseRing(value);
      if (ring !== "preview") return Promise.resolve(updates.setRing(ring));
      return persist({ ring });
    },
    setAutomatic: (value: unknown): Promise<AppUpdateState> => {
      if (typeof value !== "boolean")
        throw new TypeError("Nightly rejected an invalid update preference.");
      return persist({ automaticChecks: value });
    },
    install: async (owner: {
      readonly bootstrap: NightlyWindowBootstrap;
      readonly current: () => boolean;
    }): ReturnType<typeof updates.install> => {
      if (applying || !owner.current() || updates.state().status !== "ready")
        return { kind: "not-ready" };
      applying = true;
      try {
        const probe = await probeLocalHost({
          url: owner.bootstrap.hostOrigin,
          ...(options.fetchActivity === undefined ? {} : { fetch: options.fetchActivity }),
        });
        if (!owner.current()) return { kind: "not-ready" };
        const confirmed =
          probe?.instanceId === owner.bootstrap.hostInstance &&
          probe.activeAgentCount !== undefined;
        const work = {
          activeAgentCount: confirmed ? (probe.activeAgentCount ?? 0) : 0,
          activityUnconfirmed: !confirmed,
        };
        const readiness = resolveUpdateInstallReadiness(work);
        if (readiness.kind === "wait") return readiness;
        const closed = await options.prepare();
        if (closed.kind !== "closed" || !options.canApply()) {
          await options.recover(
            "Nightly could not confirm its window cleanup, so it did not apply the update. Quit and reopen Nightly before trying again.",
          );
          return { kind: "not-ready" };
        }
        const result = await updates.install(work);
        if (result.kind !== "installing")
          await options.recover("The Nightly update is no longer ready. Check for updates again.");
        return result;
      } catch {
        await options.recover(
          "Nightly could not apply the update. Its previous version is still running.",
        );
        return { kind: "not-ready" };
      } finally {
        applying = false;
      }
    },
  });
}
