import { describe, expect, it, vi } from "vitest";
import { MOBILE_ATTACHMENT_MAX_BYTES } from "@octant/client-runtime";
import {
  createMobileHostRegistry,
  createInMemoryMobileHostRegistryStorage,
} from "../hosts/HostRegistry";
import { createRelayChoiceStore } from "../hosts/relayChoiceStore";
import { removeMobileHost } from "../session/mobileSessionLifecycle";
import { parseMobileShareDeepLink } from "../notifications/deepLinks";
import {
  parseShareManifestV1,
  SHARE_INLINE_TEXT_MAX_CHARS,
  SHARE_MANIFEST_FILE_NAME,
  SHARE_MAX_AGE_MS,
  SHARE_MAX_ITEMS,
  utf8ByteLength,
  utf8Bytes,
} from "./shareManifest";
import {
  clearAllStagedShares,
  discardStagedShare,
  loadAndSweepStagedShares,
} from "./shareStagingStore";
import {
  classifyStagedFile,
  SHARE_REFUSAL_MESSAGES,
  sniffMediaTypeFromBytes,
  type ShareStagingFileStat,
  type ShareStagingFolderEntry,
  type ShareStagingFs,
} from "./shareValidation";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const NOW_MS = Date.parse("2026-11-28T12:00:00.000Z");

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const GIF_BYTES = utf8Bytes("GIF89a\x01\x00");
const HEIC_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);
const TIFF_BYTES = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
const SVG_BYTES = utf8Bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const PDF_BYTES = utf8Bytes("%PDF-1.7\n1 0 obj\n");

interface FakeFile {
  readonly isRegularFile?: boolean;
  readonly isSymbolicLink?: boolean;
  readonly bytes: Uint8Array;
  readonly reportedSize?: number;
}

interface FakeFolder {
  readonly isDirectory?: boolean;
  readonly isSymbolicLink?: boolean;
  readonly files: Map<string, FakeFile>;
}

function createFakeStagingFs(initial: ReadonlyArray<readonly [string, FakeFolder]> = []): {
  readonly fs: ShareStagingFs;
  readonly folders: Map<string, FakeFolder>;
  readonly deletedFolders: string[];
} {
  const folders = new Map<string, FakeFolder>(initial);
  const deletedFolders: string[] = [];

  const fs: ShareStagingFs = {
    available: true,
    listShareFolders: async (): Promise<ReadonlyArray<ShareStagingFolderEntry>> =>
      [...folders.entries()].map(([name, folder]) => ({
        name,
        isDirectory: folder.isDirectory ?? true,
        isSymbolicLink: folder.isSymbolicLink ?? false,
      })),
    statFile: async (folderName, fileName): Promise<ShareStagingFileStat> => {
      const file = folders.get(folderName)?.files.get(fileName);
      if (file === undefined) {
        return { exists: false, isRegularFile: false, isSymbolicLink: false, sizeBytes: 0 };
      }
      return {
        exists: true,
        isRegularFile: file.isRegularFile ?? true,
        isSymbolicLink: file.isSymbolicLink ?? false,
        sizeBytes: file.reportedSize ?? file.bytes.byteLength,
      };
    },
    readTextFile: async (folderName, fileName) => {
      const file = folders.get(folderName)?.files.get(fileName);
      if (file === undefined) return undefined;
      return new TextDecoder().decode(file.bytes);
    },
    readBinaryFile: async (folderName, fileName) => {
      const file = folders.get(folderName)?.files.get(fileName);
      return file?.bytes;
    },
    deleteShareFolder: async (folderName) => {
      deletedFolders.push(folderName);
      folders.delete(folderName);
    },
    deleteAllShares: async () => {
      for (const name of folders.keys()) deletedFolders.push(name);
      folders.clear();
    },
  };

  return { fs, folders, deletedFolders };
}

function folderWithManifest(
  manifest: unknown,
  extraFiles: Readonly<Record<string, FakeFile>> = {},
): FakeFolder {
  const files = new Map<string, FakeFile>([
    [SHARE_MANIFEST_FILE_NAME, { bytes: utf8Bytes(JSON.stringify(manifest)) }],
    ...Object.entries(extraFiles),
  ]);
  return { files };
}

describe("share deep-link parsing", () => {
  it("accepts only bare octant://share and rejects parameters, paths, fragments, and foreign schemes", () => {
    expect(parseMobileShareDeepLink("octant://share")).toBe(true);
    expect(parseMobileShareDeepLink("octant://share/")).toBe(false);
    expect(parseMobileShareDeepLink("octant://share?file=/etc/passwd")).toBe(false);
    expect(parseMobileShareDeepLink("octant://share?id=123")).toBe(false);
    expect(parseMobileShareDeepLink("octant://share#section")).toBe(false);
    expect(parseMobileShareDeepLink(`octant://share/${UUID_A}`)).toBe(false);
    expect(parseMobileShareDeepLink("https://share")).toBe(false);
    expect(parseMobileShareDeepLink(`octant://hosts/${UUID_A}/threads/t1`)).toBe(false);
  });
});

describe("staged share manifest and byte-level validation", () => {
  it("refuses unknown manifest fields, wrong versions, and non-http links", () => {
    expect(
      parseShareManifestV1({
        version: 1,
        id: UUID_A,
        createdAt: "2026-11-28T11:00:00.000Z",
        extra: "planted",
        items: [
          { kind: "text", name: "note.txt", declaredType: "text/plain", bytes: 2, text: "hi" },
        ],
      }).status,
    ).toBe("invalid");

    expect(
      parseShareManifestV1({
        version: 2,
        id: UUID_A,
        createdAt: "2026-11-28T11:00:00.000Z",
        items: [
          { kind: "text", name: "note.txt", declaredType: "text/plain", bytes: 2, text: "hi" },
        ],
      }).status,
    ).toBe("invalid");

    expect(
      parseShareManifestV1({
        version: 1,
        id: UUID_A,
        createdAt: "2026-11-28T11:00:00.000Z",
        items: [
          {
            kind: "link",
            name: "bad",
            declaredType: "text/uri-list",
            bytes: utf8ByteLength("javascript:alert(1)"),
            url: "javascript:alert(1)",
          },
        ],
      }).status,
    ).toBe("invalid");
  });

  it("rechecks image and file types from bytes rather than trusting declared MIME types", () => {
    expect(sniffMediaTypeFromBytes(JPEG_BYTES)).toEqual({
      kind: "cleanable-image",
      mediaType: "image/jpeg",
    });
    expect(sniffMediaTypeFromBytes(PNG_BYTES)).toEqual({
      kind: "cleanable-image",
      mediaType: "image/png",
    });
    expect(sniffMediaTypeFromBytes(WEBP_BYTES)).toEqual({
      kind: "cleanable-image",
      mediaType: "image/webp",
    });
    expect(sniffMediaTypeFromBytes(GIF_BYTES)).toEqual({
      kind: "cleanable-image",
      mediaType: "image/gif",
    });
    expect(sniffMediaTypeFromBytes(HEIC_BYTES)).toEqual({
      kind: "uncleanable-image",
      mediaType: "image/heic",
    });
    expect(sniffMediaTypeFromBytes(TIFF_BYTES)).toEqual({
      kind: "uncleanable-image",
      mediaType: "image/tiff",
    });
    expect(sniffMediaTypeFromBytes(SVG_BYTES)).toEqual({
      kind: "uncleanable-image",
      mediaType: "image/svg+xml",
    });

    // A PNG misdeclared as octet-stream is still identified as image/png so the host strips metadata.
    expect(
      classifyStagedFile({
        declaredType: "application/octet-stream",
        name: "photo.bin",
        bytes: PNG_BYTES,
      }),
    ).toEqual({ status: "ok", kind: "image", mediaType: "image/png" });

    // An uncleanable image (HEIC or TIFF) is refused instead of slipping through as a file.
    expect(
      classifyStagedFile({
        declaredType: "image/heic",
        name: "photo.heic",
        bytes: HEIC_BYTES,
      }),
    ).toEqual({
      status: "refused",
      reason: "uncleanable-image",
      message: SHARE_REFUSAL_MESSAGES.uncleanableImage,
    });

    // Non-image files like PDFs become file attachments.
    expect(
      classifyStagedFile({
        declaredType: "application/pdf",
        name: "spec.pdf",
        bytes: PDF_BYTES,
      }),
    ).toEqual({ status: "ok", kind: "file", mediaType: "application/pdf" });
  });

  it("deletes and reports non-UUID folders, symlinks, and files whose size disagrees with the manifest", async () => {
    const { fs, deletedFolders } = createFakeStagingFs([
      ["not-a-uuid", { files: new Map() }],
      [
        UUID_A,
        {
          isSymbolicLink: true,
          files: new Map(),
        },
      ],
      [
        UUID_B,
        folderWithManifest(
          {
            version: 1,
            id: UUID_B,
            createdAt: "2026-11-28T11:30:00.000Z",
            items: [
              {
                kind: "file",
                name: "photo.png",
                declaredType: "image/png",
                bytes: PNG_BYTES.byteLength,
                fileName: "item-1.png",
              },
            ],
          },
          {
            "item-1.png": {
              bytes: PNG_BYTES,
              isSymbolicLink: true,
            },
          },
        ),
      ],
    ]);

    const loaded = await loadAndSweepStagedShares(fs, NOW_MS);
    expect(loaded.shares).toEqual([]);
    expect(loaded.notices).toHaveLength(3);
    expect(deletedFolders).toEqual(["not-a-uuid", UUID_A, UUID_B]);

    // Size mismatch also deletes and reports.
    const mismatch = createFakeStagingFs([
      [
        UUID_A,
        folderWithManifest(
          {
            version: 1,
            id: UUID_A,
            createdAt: "2026-11-28T11:30:00.000Z",
            items: [
              {
                kind: "file",
                name: "photo.png",
                declaredType: "image/png",
                bytes: 999,
                fileName: "item-1.png",
              },
            ],
          },
          { "item-1.png": { bytes: PNG_BYTES } },
        ),
      ],
    ]);
    const mismatchResult = await loadAndSweepStagedShares(mismatch.fs, NOW_MS);
    expect(mismatchResult.shares).toEqual([]);
    expect(mismatch.deletedFolders).toEqual([UUID_A]);
  });

  it("maps text up to 20,000 characters inline and longer text into a .txt attachment", async () => {
    const shortText = "a".repeat(SHARE_INLINE_TEXT_MAX_CHARS);
    const longText = "b".repeat(SHARE_INLINE_TEXT_MAX_CHARS + 1);
    const link = "https://octant.sh/docs";

    const { fs } = createFakeStagingFs([
      [
        UUID_A,
        folderWithManifest({
          version: 1,
          id: UUID_A,
          createdAt: "2026-11-28T11:50:00.000Z",
          items: [
            {
              kind: "text",
              name: "short",
              declaredType: "text/plain",
              bytes: utf8ByteLength(shortText),
              text: shortText,
            },
            {
              kind: "link",
              name: "link",
              declaredType: "text/uri-list",
              bytes: utf8ByteLength(link),
              url: link,
            },
            {
              kind: "text",
              name: "long-note",
              declaredType: "text/plain",
              bytes: utf8ByteLength(longText),
              text: longText,
            },
          ],
        }),
      ],
    ]);

    const loaded = await loadAndSweepStagedShares(fs, NOW_MS);
    expect(loaded.shares).toHaveLength(1);
    const share = loaded.shares[0];
    expect(share?.refusal).toBeUndefined();
    expect(share?.textParts).toEqual([shortText, link]);
    expect(share?.attachments).toHaveLength(1);
    expect(share?.attachments[0]).toMatchObject({
      kind: "file",
      displayName: "long-note.txt",
      mediaType: "text/plain",
    });
    expect(share?.attachments[0]?.bytes.byteLength).toBe(SHARE_INLINE_TEXT_MAX_CHARS + 1);
  });

  it("refuses an uncleanable image, an 11 MiB file, and a 17th item while keeping them staged for Discard", async () => {
    const elevenMiB = MOBILE_ATTACHMENT_MAX_BYTES + 1024 * 1024;
    const seventeenItems = Array.from({ length: SHARE_MAX_ITEMS + 1 }, (_, i) => ({
      kind: "text" as const,
      name: `t-${i}`,
      declaredType: "text/plain" as const,
      bytes: 1,
      text: "x",
    }));

    const { fs } = createFakeStagingFs([
      [
        UUID_A,
        folderWithManifest(
          {
            version: 1,
            id: UUID_A,
            createdAt: "2026-11-28T11:55:00.000Z",
            items: [
              {
                kind: "file",
                name: "raw.tiff",
                declaredType: "image/tiff",
                bytes: TIFF_BYTES.byteLength,
                fileName: "item-1.tiff",
              },
            ],
          },
          { "item-1.tiff": { bytes: TIFF_BYTES } },
        ),
      ],
      [
        UUID_B,
        folderWithManifest(
          {
            version: 1,
            id: UUID_B,
            createdAt: "2026-11-28T11:54:00.000Z",
            items: [
              {
                kind: "file",
                name: "huge.pdf",
                declaredType: "application/pdf",
                bytes: elevenMiB,
                fileName: "item-1.pdf",
              },
            ],
          },
          { "item-1.pdf": { bytes: PDF_BYTES, reportedSize: elevenMiB } },
        ),
      ],
      [
        "33333333-3333-4333-8333-333333333333",
        folderWithManifest({
          version: 1,
          id: "33333333-3333-4333-8333-333333333333",
          createdAt: "2026-11-28T11:53:00.000Z",
          items: seventeenItems,
        }),
      ],
    ]);

    const loaded = await loadAndSweepStagedShares(fs, NOW_MS);
    expect(loaded.shares).toHaveLength(3);
    expect(loaded.shares[0]?.refusal?.reason).toBe("uncleanable-image");
    expect(loaded.shares[1]?.refusal?.reason).toBe("too-large");
    expect(loaded.shares[2]?.refusal?.reason).toBe("too-many-items");
  });
});

describe("staged share cleanup", () => {
  it("staged items older than a day are deleted on launch", async () => {
    const expiredAt = new Date(NOW_MS - SHARE_MAX_AGE_MS - 1000).toISOString();
    const freshAt = new Date(NOW_MS - 60_000).toISOString();
    const { fs, folders, deletedFolders } = createFakeStagingFs([
      [
        UUID_A,
        folderWithManifest({
          version: 1,
          id: UUID_A,
          createdAt: expiredAt,
          items: [{ kind: "text", name: "old", declaredType: "text/plain", bytes: 3, text: "old" }],
        }),
      ],
      [
        UUID_B,
        folderWithManifest({
          version: 1,
          id: UUID_B,
          createdAt: freshAt,
          items: [{ kind: "text", name: "new", declaredType: "text/plain", bytes: 3, text: "new" }],
        }),
      ],
    ]);

    const loaded = await loadAndSweepStagedShares(fs, NOW_MS);
    expect(deletedFolders).toEqual([UUID_A]);
    expect(folders.has(UUID_A)).toBe(false);
    expect(loaded.shares.map((share) => share.id)).toEqual([UUID_B]);
  });

  it("deletes staged items on discard and clears all staged items when the last paired computer is removed", async () => {
    const { fs, folders } = createFakeStagingFs([
      [
        UUID_A,
        folderWithManifest({
          version: 1,
          id: UUID_A,
          createdAt: "2026-11-28T11:55:00.000Z",
          items: [{ kind: "text", name: "a", declaredType: "text/plain", bytes: 1, text: "a" }],
        }),
      ],
      [
        UUID_B,
        folderWithManifest({
          version: 1,
          id: UUID_B,
          createdAt: "2026-11-28T11:55:00.000Z",
          items: [{ kind: "text", name: "b", declaredType: "text/plain", bytes: 1, text: "b" }],
        }),
      ],
    ]);

    await discardStagedShare(fs, UUID_A);
    expect(folders.has(UUID_A)).toBe(false);
    expect(folders.has(UUID_B)).toBe(true);

    // Removing one of two computers keeps remaining staged shares; removing the last clears them.
    const storage = createInMemoryMobileHostRegistryStorage();
    const registry = createMobileHostRegistry(storage);
    const relayChoices = createRelayChoiceStore(storage);
    await registry.upsert({
      hostId: "host-1",
      label: "Laptop",
      origin: "https://laptop.local:3773",
      hostKeyFingerprint: "fp-1",
      keyId: "key-1",
      credentialGeneration: 1,
    });
    await registry.upsert({
      hostId: "host-2",
      label: "Desktop",
      origin: "https://desktop.local:3773",
      hostKeyFingerprint: "fp-2",
      keyId: "key-2",
      credentialGeneration: 1,
    });
    const hub = { syncRegistrations: vi.fn() };
    const deviceKeyStore = { remove: vi.fn(async () => undefined) };

    await removeMobileHost({
      hostId: "host-1",
      registry,
      hub,
      deviceKeyStore,
      relayChoices,
      onLastHostRemoved: () => clearAllStagedShares(fs),
    });
    expect(folders.has(UUID_B)).toBe(true);

    await removeMobileHost({
      hostId: "host-2",
      registry,
      hub,
      deviceKeyStore,
      relayChoices,
      onLastHostRemoved: () => clearAllStagedShares(fs),
    });
    expect(folders.size).toBe(0);
  });
});
