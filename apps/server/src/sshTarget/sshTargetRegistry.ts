import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { SshTarget, type SshTargetId } from "@octant/contracts/ssh-target";

/**
 * Registered SSH targets and their pinned host keys, under the data directory
 * with owner-only permissions. Canonical: docs/design/remote-ssh-environments.md
 * § Registering an SSH target.
 *
 * Each target has its own known-hosts file holding exactly its pinned key for
 * every name (`*`), and the client connects with that file alone. Matching any
 * name is what lets the person's own configuration resolve the destination
 * (an alias, another port, a jump host) without the pin depending on which
 * name the client looks up; the file never vouches for another target.
 *
 * Only a local window or the local CLI changes this store, through the
 * administration routes.
 */

const DIRECTORY = "ssh-targets";
const TARGET_FILE = "target.json";
const KNOWN_HOSTS_FILE = "known_hosts";

const decodeTarget = Schema.decodeUnknownEither(Schema.parseJson(SshTarget));

export class SshTargetRegistry {
  readonly #root: string;

  constructor(dataDirectory: string) {
    this.#root = join(dataDirectory, DIRECTORY);
  }

  /** Every target whose record reads back exactly; any other is left out. */
  list(): ReadonlyArray<SshTarget> {
    let names: ReadonlyArray<string>;
    try {
      names = readdirSync(this.#root);
    } catch {
      return [];
    }
    const targets: SshTarget[] = [];
    for (const name of names) {
      const target = this.#read(name);
      if (target !== undefined && String(target.id) === name) targets.push(target);
    }
    return targets;
  }

  get(id: SshTargetId): SshTarget | undefined {
    const target = this.#read(String(id));
    return target !== undefined && String(target.id) === String(id) ? target : undefined;
  }

  knownHostsFile(id: SshTargetId): string {
    return join(this.#root, String(id), KNOWN_HOSTS_FILE);
  }

  /** A private scratch directory for one host-key probe, removed by the caller. */
  probeDirectory(name: string): string {
    const directory = join(this.#root, ".probes", name);
    mkdirSync(join(this.#root, ".probes"), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    return directory;
  }

  /** Writes the pin first, so a record never names a key its file does not hold. */
  save(target: SshTarget): void {
    const directory = join(this.#root, String(target.id));
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeOwnerOnly(
      this.knownHostsFile(target.id),
      `* ${target.hostKey.algorithm} ${target.hostKey.publicKey}\n`,
    );
    writeOwnerOnly(join(directory, TARGET_FILE), JSON.stringify(target));
  }

  remove(id: SshTargetId): void {
    rmSync(join(this.#root, String(id)), { recursive: true, force: true });
  }

  #read(name: string): SshTarget | undefined {
    if (name.startsWith(".")) return undefined;
    let text: string;
    try {
      text = readFileSync(join(this.#root, name, TARGET_FILE), "utf8");
    } catch {
      return undefined;
    }
    const decoded = decodeTarget(text);
    return decoded._tag === "Right" ? decoded.right : undefined;
  }
}

function writeOwnerOnly(path: string, content: string): void {
  const staging = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(staging, content, { mode: 0o600 });
  // The mode applies only when the file is created, so a staging file left by
  // a crashed save is narrowed here too.
  chmodSync(staging, 0o600);
  renameSync(staging, path);
}
