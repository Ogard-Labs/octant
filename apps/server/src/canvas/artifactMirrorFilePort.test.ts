import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactMirrorFilePort, isInsideHomeDirectory } from "./artifactMirrorFilePort";

/**
 * Runs just before the port resolves, opens, creates, or removes a path, so a
 * test can swap a directory then. A removal from a held directory names the
 * entry by its final component only, so tests match on that.
 */
const resolving = vi.hoisted(() => ({
  before: (_step: "realpath" | "open" | "create" | "remove", _path: string): void => undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const creates = (flags: unknown) =>
    typeof flags === "number"
      ? (flags & actual.constants.O_CREAT) !== 0
      : typeof flags === "string" && /[wa]/.test(flags);
  return {
    ...actual,
    realpath: async (path: string) => {
      resolving.before("realpath", path);
      return await actual.realpath(path);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      resolving.before("open", String(args[0]));
      if (creates(args[1])) resolving.before("create", String(args[0]));
      return await actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      resolving.before("open", String(args[0]));
      return await actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      resolving.before("open", String(args[0]));
      resolving.before("create", String(args[0]));
      return await actual.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      resolving.before("remove", String(args[0]));
      return await actual.rm(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      resolving.before("remove", String(args[0]));
      return await actual.unlink(...args);
    },
  };
});
// macOS removes a name through a child process working in the proven folder.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      argv: ReadonlyArray<string>,
      options: { readonly cwd?: string },
      callback: (error: Error | null) => void,
    ) => {
      resolving.before("remove", `${options.cwd ?? ""}/${argv[argv.length - 1] ?? ""}`);
      return actual.execFile(file, argv, options, callback);
    },
  };
});

const directories: Array<string> = [];
afterEach(() => {
  resolving.before = () => undefined;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * A checkout holding a mirrored bundle under `docs`, and a host folder with the
 * same relative names, so a read that follows `docs` swapped for a link returns
 * host bytes rather than failing to find them.
 */
function mirroredCheckout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-mirror-read-")));
  directories.push(base);
  const root = join(base, "checkout");
  const outside = join(base, "outside");
  mkdirSync(join(root, "docs", "artifacts"), { recursive: true });
  mkdirSync(join(outside, "artifacts"), { recursive: true });
  writeFileSync(join(root, "docs", "artifacts", "plan.octant.json"), "mirrored bundle");
  writeFileSync(join(root, "docs", "artifacts", "old-plan.md"), "stale sidecar");
  writeFileSync(join(outside, "artifacts", "plan.octant.json"), "host secret");
  writeFileSync(join(outside, "artifacts", "old-plan.md"), "host notes");
  return {
    root,
    bundle: join(root, "docs", "artifacts", "plan.octant.json"),
    /** A sidecar the mirror has not written yet, so writing it creates a file. */
    sidecar: join(root, "docs", "artifacts", "plan.md"),
    stale: join(root, "docs", "artifacts", "old-plan.md"),
    /** Every name and byte under the host folder, to prove nothing there changed. */
    host: () => snapshot(outside),
    toLink: () => {
      renameSync(join(root, "docs"), join(root, "docs-real"));
      symlinkSync(outside, join(root, "docs"));
    },
  };
}

describe("reading a mirrored bundle back from an agent-writable root", () => {
  it("reads the bundle the mirror wrote", async () => {
    const checkout = mirroredCheckout();
    await expect(createArtifactMirrorFilePort().read(checkout.bundle, checkout.root)).resolves.toBe(
      "mirrored bundle",
    );
  });

  // Re-import reads the bundle at the path the mirror last wrote. An agent in
  // the checkout can rename `docs` and leave a link to a host folder holding
  // the same names; a plain read followed it and handed host bytes to re-import.
  it("refuses a bundle whose ancestor is already a link to a host folder", async () => {
    const checkout = mirroredCheckout();
    checkout.toLink();
    await expect(
      createArtifactMirrorFilePort().read(checkout.bundle, checkout.root),
    ).resolves.toBeUndefined();
  });

  it.each(["realpath", "open"] as const)(
    "refuses a bundle whose ancestor is swapped for a host link before %s",
    async (step) => {
      const checkout = mirroredCheckout();
      let swapped = false;
      resolving.before = (current, path) => {
        if (swapped || current !== step || !path.startsWith(join(checkout.root, "docs"))) return;
        swapped = true;
        checkout.toLink();
      };
      await expect(
        createArtifactMirrorFilePort().read(checkout.bundle, checkout.root),
      ).resolves.toBeUndefined();
    },
  );
});

function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    const path = join(directory, name);
    entries[name] = statSync(path).isDirectory() ? "<folder>" : readFileSync(path, "utf8");
  }
  return entries;
}

describe("writing a mirrored file into an agent-writable root", () => {
  it("replaces the bundle and creates a sidecar, with the folders it needs, inside the root", async () => {
    const checkout = mirroredCheckout();
    const port = createArtifactMirrorFilePort();
    const nested = join(checkout.root, "docs", "artifacts", "notes", "plan.md");

    await port.write(checkout.bundle, "revised bundle", checkout.root);
    await port.write(nested, "rendered notes", checkout.root);

    expect(readFileSync(checkout.bundle, "utf8")).toBe("revised bundle");
    expect(readFileSync(nested, "utf8")).toBe("rendered notes");
  });

  // An agent in the checkout can rename `docs` and leave a link to a host
  // folder. The write created folders by path and then compared a folder with
  // itself, so the bundle replaced the host file of the same name and a new
  // sidecar was created beside it.
  it.each(["bundle", "sidecar"] as const)(
    "refuses a %s whose folder is already a link to a host folder",
    async (target) => {
      const checkout = mirroredCheckout();
      checkout.toLink();
      const before = checkout.host();

      await expect(
        createArtifactMirrorFilePort().write(checkout[target], "agent bytes", checkout.root),
      ).rejects.toThrow();

      expect(checkout.host()).toEqual(before);
    },
  );

  it.each([
    ["bundle", "open"],
    ["sidecar", "open"],
    ["sidecar", "create"],
  ] as const)(
    "puts nothing in a host folder swapped in for the %s's folder before its %s",
    async (target, step) => {
      const checkout = mirroredCheckout();
      const before = checkout.host();
      const leaf = `/${checkout[target].split("/").at(-1) ?? ""}`;
      let swapped = false;
      resolving.before = (current, path) => {
        if (swapped || current !== step || !path.endsWith(leaf)) return;
        swapped = true;
        checkout.toLink();
      };

      await createArtifactMirrorFilePort()
        .write(checkout[target], "agent bytes", checkout.root)
        .catch(() => undefined);

      expect(swapped).toBe(true);
      expect(checkout.host()).toEqual(before);
    },
  );
});

describe("removing a stale mirrored file from an agent-writable root", () => {
  it("removes the stale file", async () => {
    const checkout = mirroredCheckout();
    await createArtifactMirrorFilePort().remove(checkout.stale, checkout.root);
    expect(() => statSync(checkout.stale)).toThrow();
  });

  // The same swap turned removing a renamed artifact's old sidecar into
  // deleting the host file with that name.
  it("refuses a stale file whose folder is already a link to a host folder", async () => {
    const checkout = mirroredCheckout();
    checkout.toLink();
    const before = checkout.host();

    await expect(
      createArtifactMirrorFilePort().remove(checkout.stale, checkout.root),
    ).rejects.toThrow();

    expect(checkout.host()).toEqual(before);
  });

  it("deletes nothing in a host folder swapped in for the stale file's folder during the removal", async () => {
    const checkout = mirroredCheckout();
    const before = checkout.host();
    let swapped = false;
    resolving.before = (current, path) => {
      if (swapped || current !== "remove" || !path.endsWith("/old-plan.md")) return;
      swapped = true;
      checkout.toLink();
    };

    await createArtifactMirrorFilePort()
      .remove(checkout.stale, checkout.root)
      .catch(() => undefined);

    expect(swapped).toBe(true);
    expect(checkout.host()).toEqual(before);
  });
});

describe("judging whether a chosen folder is inside the home folder", () => {
  function homeBehindLink() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-mirror-home-")));
    directories.push(base);
    const realHome = join(base, "volume", "ada");
    mkdirSync(join(realHome, "Artifacts"), { recursive: true });
    const linkedHome = join(base, "home-ada");
    symlinkSync(realHome, linkedHome);
    return { base, realHome, linkedHome };
  }

  // Folders are stored by their real path, but the home folder was compared as
  // written, so where home is itself a link every newly chosen folder was
  // refused as outside it.
  it("counts a folder stored by its real path as inside a home folder that is a link", () => {
    const home = homeBehindLink();

    expect(isInsideHomeDirectory(join(home.realHome, "Artifacts"), home.linkedHome)).toBe(true);
    expect(isInsideHomeDirectory(join(home.realHome, "Not yet made"), home.linkedHome)).toBe(true);
    expect(isInsideHomeDirectory(home.realHome, home.linkedHome)).toBe(false);
  });

  it("counts a link inside home that leads out of it as outside home", () => {
    const home = homeBehindLink();
    const outside = join(home.base, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, join(home.realHome, "Elsewhere"));

    expect(isInsideHomeDirectory(join(home.realHome, "Elsewhere"), home.realHome)).toBe(false);
  });
});
