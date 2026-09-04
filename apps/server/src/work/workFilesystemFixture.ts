import type {
  WorkFileStat,
  WorkFilesystemPort,
  WorkOpenDirectory,
  WorkOpenFile,
  WorkOpenWriteFile,
} from "./workFilesystemPort";

/**
 * In-memory Work filesystem for tests, shared by every suite that drives the
 * mutation service through a real confinement sequence.
 *
 * It exists because the confined-read discipline is only as honest as the fake
 * it is proved against: object identity has to survive a rewrite and change on
 * a replacement, and a handle has to keep answering for the object it opened
 * after the name it was opened under means something else. One implementation
 * keeps every suite testing the same filesystem semantics rather than five
 * subtly different ones.
 */
export interface WorkFilesystemFixture extends WorkFilesystemPort {
  /** Bytes currently at `path`, for asserting what a mutation actually wrote. */
  readBytes(path: string): Uint8Array | undefined;
  /** Replace `path` with a symlink, the way a racing process would. */
  putSymlink(path: string, target: string): void;
  /** Replace `path` with a different object, so its identity no longer matches. */
  putFile(path: string, bytes: Uint8Array): void;
}

interface FileNode {
  bytes: Uint8Array;
  readonly inode: string;
}

export function workFilesystemFixture(root = "/work"): WorkFilesystemFixture {
  const files = new Map<string, FileNode>();
  const dirs = new Set<string>([root]);
  const dirInodes = new Map<string, string>();
  const symlinks = new Map<string, string>();
  let nextInode = 0;
  const mintInode = (): string => {
    nextInode += 1;
    return String(nextInode);
  };
  const inodeForDir = (path: string): string => {
    const existing = dirInodes.get(path);
    if (existing !== undefined) return existing;
    const assigned = mintInode();
    dirInodes.set(path, assigned);
    return assigned;
  };
  const resolve = (path: string): string => symlinks.get(path) ?? path;
  const writeHandle = (node: FileNode): WorkOpenWriteFile => ({
    stat: async () => ({
      isFile: true,
      size: node.bytes.byteLength,
      device: "1",
      inode: node.inode,
    }),
    write: async (bytes) => {
      node.bytes = bytes;
    },
    close: async () => {},
  });
  const childPath = (parent: string, name: string): string => {
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\0")
    ) {
      throw new Error(`invalid directory entry ${name}`);
    }
    return parent === "/" ? `/${name}` : `${parent}/${name}`;
  };
  const directoryHandle = (captured: string, inode: string): WorkOpenDirectory => {
    // The enumeration cursor belongs to the handle, so a second read continues
    // where the first stopped exactly as an open directory stream does.
    let offset = 0;
    return {
      stat: async () => ({
        isDirectory: true,
        device: "1",
        inode,
      }),
      read: async (maximumEntries) => {
        const prefix = captured === "/" ? "/" : `${captured}/`;
        const names = new Set<string>();
        for (const path of [...dirs, ...files.keys(), ...symlinks.keys()]) {
          if (path === captured || !path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          if (rest.length === 0) continue;
          const head = rest.split("/")[0];
          if (head !== undefined && head.length > 0) names.add(head);
        }
        const ordered = [...names].sort();
        const page = ordered.slice(offset, offset + Math.max(0, maximumEntries));
        offset += page.length;
        return page.map((name) => ({ name }));
      },
      openDirectory: async (name) => {
        const child = childPath(captured, name);
        if (symlinks.has(child)) throw new Error(`ELOOP ${child}`);
        if (!dirs.has(child)) throw new Error(`no dir at ${child}`);
        return directoryHandle(child, inodeForDir(child));
      },
      mkdir: async (name) => {
        dirs.add(childPath(captured, name));
      },
      openWriteFile: async (name, options) => {
        const child = childPath(captured, name);
        if (symlinks.has(child)) throw new Error(`ELOOP ${child}`);
        if (options.exclusiveCreate) {
          if (files.has(child) || dirs.has(child)) throw new Error(`EEXIST ${child}`);
          const node: FileNode = { bytes: new Uint8Array(), inode: mintInode() };
          files.set(child, node);
          return writeHandle(node);
        }
        const opened = files.get(child);
        if (opened === undefined) throw new Error(`no file at ${child}`);
        return writeHandle(opened);
      },
      close: async () => {},
    };
  };
  const realpath = async (path: string): Promise<string> => resolve(path);
  const statFor = (path: string): WorkFileStat => {
    if (symlinks.has(path)) {
      return {
        isDirectory: false,
        isFile: false,
        isSymbolicLink: true,
        size: 0,
        device: "1",
        inode: "0",
      };
    }
    if (dirs.has(path)) {
      return {
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
        size: 0,
        device: "1",
        inode: inodeForDir(path),
      };
    }
    const node = files.get(path);
    if (node !== undefined) {
      return {
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
        size: node.bytes.byteLength,
        device: "1",
        inode: node.inode,
      };
    }
    throw new Error(`no entry at ${path}`);
  };
  return {
    realpath,
    lstat: async (path) => statFor(path),
    // `stat`, `readFile`, and `writeFile` follow a symlink the way the host's do;
    // only `lstat` and the open see the link itself. Anything less would let a
    // confined read look safe in a test for a reason the host would not honour.
    stat: async (path) => statFor(resolve(path)),
    readlink: async (path) => {
      const target = symlinks.get(path);
      if (target === undefined) throw new Error(`no symlink at ${path}`);
      return target;
    },
    // Models an `O_NOFOLLOW` open: a symlinked final component is refused, and
    // the handle keeps answering for the object it captured however the name is
    // rewritten afterwards.
    openFile: async (path): Promise<WorkOpenFile> => {
      if (symlinks.has(path)) throw new Error(`ELOOP ${path}`);
      const opened = files.get(path);
      if (opened === undefined) throw new Error(`no file at ${path}`);
      return {
        stat: async () => ({
          isFile: true,
          size: opened.bytes.byteLength,
          device: "1",
          inode: opened.inode,
        }),
        read: async (maximumBytes) => opened.bytes.slice(0, Math.max(0, maximumBytes)),
        close: async () => {},
      };
    },
    openWriteFile: async (path, options): Promise<WorkOpenWriteFile> => {
      if (symlinks.has(path)) throw new Error(`ELOOP ${path}`);
      const dir = path.split("/").slice(0, -1).join("/") || "/";
      if (!dirs.has(dir)) throw new Error(`missing dir ${dir}`);
      if (options.exclusiveCreate) {
        if (files.has(path) || dirs.has(path)) throw new Error(`EEXIST ${path}`);
        const node: FileNode = { bytes: new Uint8Array(), inode: mintInode() };
        files.set(path, node);
        return writeHandle(node);
      }
      const opened = files.get(path);
      if (opened === undefined) throw new Error(`no file at ${path}`);
      return writeHandle(opened);
    },
    openDirectory: async (path): Promise<WorkOpenDirectory> => {
      if (symlinks.has(path)) throw new Error(`ELOOP ${path}`);
      if (!dirs.has(path)) throw new Error(`no dir at ${path}`);
      return directoryHandle(path, inodeForDir(path));
    },
    readFile: async (path) => {
      const node = files.get(resolve(path));
      if (node === undefined) throw new Error(`no file at ${path}`);
      return node.bytes;
    },
    // A rewrite truncates in place, so the object keeps its identity — the same
    // thing `O_TRUNC` does on a real host.
    writeFile: async (path, bytes) => {
      const target = resolve(path);
      const dir = target.split("/").slice(0, -1).join("/") || "/";
      if (!dirs.has(dir)) throw new Error(`missing dir ${dir}`);
      const existing = files.get(target);
      if (existing === undefined) files.set(target, { bytes, inode: mintInode() });
      else existing.bytes = bytes;
    },
    mkdir: async (path) => {
      dirs.add(path);
    },
    unlink: async (path) => {
      if (!files.delete(path)) throw new Error(`no file at ${path}`);
    },
    // A rename carries the object, and with it the object's identity.
    rename: async (from, to) => {
      const node = files.get(from);
      if (node === undefined) throw new Error(`no file at ${from}`);
      files.delete(from);
      files.set(to, node);
    },
    readBytes: (path) => files.get(path)?.bytes,
    putSymlink: (path, target) => {
      files.delete(path);
      symlinks.set(path, target);
    },
    putFile: (path, bytes) => {
      symlinks.delete(path);
      files.set(path, { bytes, inode: mintInode() });
    },
  };
}
