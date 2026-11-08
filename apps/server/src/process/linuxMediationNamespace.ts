import { lstat, opendir, readlink, stat } from "node:fs/promises";
import type { BigIntStats as FileIdentity } from "node:fs";
import type { SecretGuardMediationPolicy } from "./secretGuard";
import {
  linuxMediationObjectKey,
  readLinuxMediationPolicy,
  type LinuxMediationMetadata,
  type LinuxMediationNamespace,
} from "./linuxMediationPolicy";

export interface LinuxMediationMutation {
  readonly operation: "unlink" | "rmdir" | "rename";
  /** Broker-owned, retained O_PATH directory. Never a guest-supplied path. */
  readonly source: { readonly parent: string; readonly name: Buffer };
  readonly destination?: { readonly parent: string; readonly name: Buffer };
  readonly flags: number;
}
export type LinuxMediationCreation = {
  /** Broker-owned retained directory, with its kernel-verified identity. */
  readonly destination: { readonly parent: string; readonly name: Buffer };
} & (
  | { readonly operation: "create" | "tmpfile" }
  | { readonly operation: "link"; readonly sourceObject: string }
);
type MutationResult = {
  readonly status: "allowed" | "refused" | "unavailable";
  readonly epoch: bigint;
};
interface Entry {
  readonly backing: string;
  readonly identity: FileIdentity;
}
interface Node extends Entry {
  readonly path: string;
}
const bytePath = (path: string) => Buffer.from(path, "utf8").toString("latin1");
const native = (path: string) => Buffer.from(path, "latin1");
const append = (parent: string, name: string) => `${parent === "/" ? "" : parent}/${name}`;
const absent = () => Object.assign(new Error("Absent in proposed namespace"), { code: "ENOENT" });
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** Classifies a future name without creating a placeholder or inventing an inode. */
export async function classifyLinuxMediationCreation(
  policy: SecretGuardMediationPolicy,
  creation: LinuxMediationCreation,
  readNamespace: () => Promise<LinuxMediationNamespace>,
): Promise<MutationResult> {
  const unavailable: MutationResult = { status: "unavailable", epoch: 0n };
  try {
    const { parent, name } = creation.destination;
    if (
      !parent.startsWith("/") ||
      parent.includes("\0") ||
      (creation.operation === "tmpfile") !== (name.length === 0) ||
      (creation.operation === "link" && !/^\d+:\d+:[1-9]\d*$/.test(creation.sourceObject))
    )
      return unavailable;
    const identity = await stat(Buffer.from(parent), { bigint: true });
    if (!identity.isDirectory()) return unavailable;
    const snapshot = await readLinuxMediationPolicy(policy, readNamespace, undefined, {
      parentObject: linuxMediationObjectKey(identity),
      name,
    });
    if (snapshot.status !== "ready") return unavailable;
    const current = await readNamespace();
    if (current.activeMutations !== 0 || current.epoch !== snapshot.epoch) return unavailable;
    if (name.length > 0) {
      try {
        await lstat(
          Buffer.concat([Buffer.from(parent.endsWith("/") ? parent : `${parent}/`), name]),
        );
        const unchanged = await readNamespace();
        // The VFS returns EEXIST (or handles an existing O_CREAT target). Any
        // actual replacement still needs the kernel's final epoch comparison.
        return unchanged.activeMutations === 0 && unchanged.epoch === snapshot.epoch
          ? { status: "allowed", epoch: snapshot.epoch }
          : unavailable;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    const final = await readNamespace();
    if (final.activeMutations !== 0 || final.epoch !== snapshot.epoch) return unavailable;
    const refused =
      snapshot.proposedEntryProtected !== false ||
      (creation.operation === "link" && snapshot.protectedObjects.has(creation.sourceObject));
    return { status: refused ? "refused" : "allowed", epoch: snapshot.epoch };
  } catch {
    return unavailable;
  }
}

/**
 * Re-evaluates the original policy in a metadata-only proposed namespace. No
 * actual rename/unlink, content copy, permanent inode floor or host write lock
 * is involved. The kernel must still bind the final operation and epoch.
 */
export async function classifyLinuxMediationMutation(
  policy: SecretGuardMediationPolicy,
  mutation: LinuxMediationMutation,
  readNamespace: () => Promise<LinuxMediationNamespace>,
): Promise<MutationResult> {
  const unavailable: MutationResult = { status: "unavailable", epoch: 0n };
  try {
    if (
      mutation.flags < 0 ||
      mutation.flags > 2 ||
      (mutation.operation !== "rename" && mutation.flags !== 0) ||
      (mutation.operation === "rename") !== (mutation.destination !== undefined)
    )
      return unavailable;
    for (const place of [mutation.source, mutation.destination]) {
      if (
        place !== undefined &&
        (!place.parent.startsWith("/") ||
          place.name.length === 0 ||
          place.name.length > 255 ||
          place.name.includes(0) ||
          place.name.includes(47) ||
          place.name.equals(Buffer.from(".")) ||
          place.name.equals(Buffer.from("..")))
      )
        return unavailable;
    }
    const before = await readLinuxMediationPolicy(policy, readNamespace);
    if (before.status !== "ready") return unavailable;
    const sourceParent = await stat(Buffer.from(mutation.source.parent), { bigint: true });
    const destinationParent =
      mutation.destination === undefined
        ? undefined
        : await stat(Buffer.from(mutation.destination.parent), { bigint: true });
    if (
      !sourceParent.isDirectory() ||
      (destinationParent !== undefined && !destinationParent.isDirectory())
    )
      return unavailable;
    const sourceKey = linuxMediationObjectKey(sourceParent);
    const destinationKey =
      destinationParent === undefined ? undefined : linuxMediationObjectKey(destinationParent);
    const sourceName = mutation.source.name.toString("latin1");
    const destinationName = mutation.destination?.name.toString("latin1");
    const sourceBacking = append(bytePath(mutation.source.parent), sourceName);
    const destinationBacking =
      mutation.destination === undefined || destinationName === undefined
        ? undefined
        : append(bytePath(mutation.destination.parent), destinationName);
    const unchanged = async (): Promise<MutationResult> => {
      const current = await readNamespace();
      return current.activeMutations === 0 && current.epoch === before.epoch
        ? { status: "allowed", epoch: current.epoch }
        : unavailable;
    };
    let source: Entry;
    try {
      source = {
        backing: sourceBacking,
        identity: await lstat(native(sourceBacking), { bigint: true }),
      };
    } catch (error) {
      if (missing(error)) return unchanged();
      throw error;
    }
    if (
      (mutation.operation === "unlink" && source.identity.isDirectory()) ||
      (mutation.operation === "rmdir" && !source.identity.isDirectory())
    )
      return unchanged();
    if (
      mutation.operation === "rename" &&
      sourceKey === destinationKey &&
      sourceName === destinationName
    )
      return unchanged();
    let destination: Entry | undefined;
    if (destinationBacking !== undefined) {
      try {
        destination = {
          backing: destinationBacking,
          identity: await lstat(native(destinationBacking), { bigint: true }),
        };
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    // These operations have no possible namespace effect; preserve their real
    // VFS EEXIST/ENOENT result rather than inventing a policy refusal.
    if (
      (mutation.flags === 1 && destination !== undefined) ||
      (mutation.flags === 2 && destination === undefined)
    )
      return unchanged();
    const deadline = performance.now() + 1_000;
    let operations = 0;
    const budget = () => {
      if (++operations > 65_536 || performance.now() > deadline)
        throw Error("Metadata budget exhausted");
    };
    const changed = (parent: Entry, name: string) => {
      const parentKey = linuxMediationObjectKey(parent.identity);
      if (parentKey === sourceKey && name === sourceName)
        return mutation.flags === 2 ? destination : null;
      if (parentKey === destinationKey && name === destinationName) return source;
      return undefined;
    };
    const cache = new Map<string, Node>();
    const root: Node = { path: "/", backing: "/", identity: await lstat("/", { bigint: true }) };
    cache.set("/", root);
    const resolve = async (path: Buffer, followFinal = true): Promise<Node> => {
      budget();
      const segments = path.toString("latin1").split("/");
      const stack: Node[] = [root];
      let followed = 0;
      for (let index = 0; index < segments.length; index++) {
        budget();
        const name = segments[index];
        if (name === undefined || name === "" || name === ".") continue;
        if (name === "..") {
          if (stack.length > 1) stack.pop();
          continue;
        }
        const parent = stack[stack.length - 1];
        if (parent === undefined || !parent.identity.isDirectory()) throw absent();
        const logical = append(parent.path, name);
        let next = cache.get(logical);
        if (next === undefined) {
          const replacement = changed(parent, name);
          if (replacement === null) throw absent();
          const entry = replacement ?? {
            backing: append(parent.backing, name),
            identity: await lstat(native(append(parent.backing, name)), { bigint: true }),
          };
          next = { ...entry, path: logical };
          cache.set(logical, next);
        }
        if (next.identity.isSymbolicLink() && (followFinal || index < segments.length - 1)) {
          if (++followed > 40) throw Error("Symbolic link budget exhausted");
          const target = (await readlink(native(next.backing), { encoding: "buffer" })).toString(
            "latin1",
          );
          if (target.startsWith("/")) stack.splice(1);
          // Relative targets start at the new logical parent, so moving a
          // symlink never assumes its old target survives the operation.
          segments.splice(index + 1, 0, ...target.split("/"));
        } else stack.push(next);
      }
      const node = stack[stack.length - 1];
      if (node === undefined) throw absent();
      return node;
    };
    const metadata: LinuxMediationMetadata = {
      lstat: async (path) => (await resolve(path, false)).identity,
      stat: async (path) => (await resolve(path)).identity,
      realpath: async (path) => native((await resolve(path)).path),
      async *names(path) {
        const node = await resolve(path);
        const key = linuxMediationObjectKey(node.identity);
        const names = new Set<string>();
        const directory = await opendir(native(node.backing), { encoding: "latin1" });
        for await (const entry of directory) {
          budget();
          names.add(entry.name);
        }
        if (key === sourceKey) {
          names.delete(sourceName);
          if (mutation.flags === 2) names.add(sourceName);
        }
        if (key === destinationKey && destinationName !== undefined) names.add(destinationName);
        for (const name of names) {
          budget();
          yield name;
        }
      },
    };
    const after = await readLinuxMediationPolicy(policy, readNamespace, metadata);
    if (after.status !== "ready" || after.epoch !== before.epoch) return unavailable;
    for (const object of before.protectedObjects)
      if (!after.protectedObjects.has(object)) return { status: "refused", epoch: after.epoch };
    return { status: "allowed", epoch: after.epoch };
  } catch {
    return unavailable;
  }
}
