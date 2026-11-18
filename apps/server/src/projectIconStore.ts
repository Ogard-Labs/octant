import { randomBytes } from "node:crypto";
import { mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectId } from "@octant/contracts";
import {
  bytesMatch,
  MAX_PROJECT_ICON_BYTES,
  readCandidate,
  type OpenIconFile,
  type ProjectCustomIconLookup,
  type ProjectIconLookup,
  type ProjectIconMediaType,
} from "./projectIcon";

const EXTENSIONS = ["svg", "png", "ico"] as const;
type IconExtension = (typeof EXTENSIONS)[number];

const MEDIA_TYPES: Readonly<
  Record<string, { extension: IconExtension; mediaType: ProjectIconMediaType }>
> = {
  "image/png": { extension: "png", mediaType: "image/png" },
  "image/svg+xml": { extension: "svg", mediaType: "image/svg+xml" },
  "image/x-icon": { extension: "ico", mediaType: "image/x-icon" },
  "image/vnd.microsoft.icon": { extension: "ico", mediaType: "image/x-icon" },
};

/** A Project id names a file, so only the plain identifier alphabet is accepted. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type ProjectIconStoreResult =
  | { readonly status: "stored" }
  | {
      readonly status: "refused";
      readonly reason: "unsupported-type" | "empty" | "too-large" | "not-an-image";
      readonly message: string;
    };

/**
 * The icon a person chose for a Project. The host keeps its own copy of the
 * bytes it was given, in its own data folder, and never reads the chosen file
 * again: the picture is served from here for as long as it is set, wherever the
 * original goes. One file per Project, named by the Project's id, so setting a
 * new one replaces the old and removing it leaves the folder's own icon.
 */
export class ProjectCustomIconStore implements ProjectCustomIconLookup {
  readonly #directory: string;
  readonly #platform: NodeJS.Platform;
  readonly #openFile: OpenIconFile | undefined;

  constructor(options: {
    readonly dataDirectory: string;
    readonly platform?: NodeJS.Platform;
    readonly openFile?: OpenIconFile;
  }) {
    this.#directory = join(options.dataDirectory, "project-icons");
    this.#platform = options.platform ?? process.platform;
    this.#openFile = options.openFile;
  }

  async read(projectId: ProjectId): Promise<ProjectIconLookup> {
    const id = String(projectId);
    if (!SAFE_ID.test(id)) return { status: "none" };
    let root: string;
    try {
      root = await realpath(this.#directory);
    } catch {
      return { status: "none" };
    }
    for (const extension of EXTENSIONS) {
      // The same fixed-name, no-follow read the folder lookup uses: a link
      // planted in the store is not an icon.
      const found = await readCandidate(
        root,
        `${id}.${extension}`,
        this.#platform,
        this.#openFile ?? open,
      );
      if (found !== undefined) return found;
    }
    return { status: "none" };
  }

  async write(
    projectId: ProjectId,
    bytes: Uint8Array,
    contentType: string | null,
  ): Promise<ProjectIconStoreResult> {
    const id = String(projectId);
    const kind = MEDIA_TYPES[(contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""];
    if (kind === undefined || !SAFE_ID.test(id)) {
      return {
        status: "refused",
        reason: "unsupported-type",
        message: "Choose a PNG, SVG or ICO image.",
      };
    }
    if (bytes.byteLength === 0) {
      return { status: "refused", reason: "empty", message: "That file is empty." };
    }
    if (bytes.byteLength > MAX_PROJECT_ICON_BYTES) {
      return {
        status: "refused",
        reason: "too-large",
        message: "That image is larger than 256 KB. Choose a smaller icon.",
      };
    }
    // The type the picker reported is a claim; the first bytes must agree.
    if (!bytesMatch(kind.mediaType, bytes)) {
      return {
        status: "refused",
        reason: "not-an-image",
        message: `That file is not a valid ${kind.extension.toUpperCase()} image.`,
      };
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.#directory, `.${id}.${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, join(this.#directory, `${id}.${kind.extension}`));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await this.#removeOthers(id, kind.extension);
    return { status: "stored" };
  }

  async remove(projectId: ProjectId): Promise<void> {
    const id = String(projectId);
    if (!SAFE_ID.test(id)) return;
    await this.#removeOthers(id, undefined);
  }

  async #removeOthers(id: string, keep: IconExtension | undefined): Promise<void> {
    for (const extension of EXTENSIONS) {
      if (extension === keep) continue;
      await unlink(join(this.#directory, `${id}.${extension}`)).catch(() => undefined);
    }
  }
}
