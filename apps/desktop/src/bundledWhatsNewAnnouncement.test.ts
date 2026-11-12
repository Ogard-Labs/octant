import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodeLastShownVersion, loadBundledWhatsNew } from "./bundledWhatsNew";
import {
  MAX_ANNOUNCEMENT_FILE_CHARS,
  MAX_ANNOUNCEMENT_PICTURE_BYTES,
  MAX_ANNOUNCEMENTS,
  loadBundledAnnouncements,
  parseAnnouncementFile,
  readAtMost,
} from "./bundledWhatsNewAnnouncement";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function announcementJson(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    title: "Canvas comments",
    body: "Point at it.",
    ...extra,
  });
}

function setJson(entries: ReadonlyArray<unknown>, extra: Readonly<Record<string, unknown>> = {}) {
  return JSON.stringify({ schemaVersion: 2, announcements: entries, ...extra });
}

function entry(n: number, extra: Readonly<Record<string, unknown>> = {}) {
  return { title: `Feature ${n}`, body: `Body ${n}.`, ...extra };
}

const FOLDER = "/app/resources";
const FILE = `${FOLDER}/whats-new-announcement.json`;

function pngBytes(length = 16): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(PNG_HEAD);
  return bytes;
}

function memoryFiles(entries: Readonly<Record<string, string | Uint8Array>>) {
  const read = (path: string) => {
    const contents = entries[path];
    if (contents === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return contents;
  };
  return {
    readFile: async (path: string) => {
      const contents = read(path);
      return typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8");
    },
    // Like the real reader: never more than the cap plus one byte.
    readBounded: async (path: string, maxBytes: number) => {
      const contents = read(path);
      const bytes = typeof contents === "string" ? Buffer.from(contents) : contents;
      return bytes.subarray(0, maxBytes + 1);
    },
  };
}

describe("bundled What's new announcement", () => {
  it("still reads a version 1 file as a list of one, with a title, body, action label and picture name", () => {
    expect(
      parseAnnouncementFile(
        announcementJson({
          actionLabel: "Take a look",
          picture: "canvas.png",
          pictureAlt: "A mark",
        }),
      ),
    ).toEqual([
      {
        title: "Canvas comments",
        body: "Point at it.",
        actionLabel: "Take a look",
        pictureName: "canvas.png",
        pictureAlt: "A mark",
      },
    ]);
  });

  it("treats bad JSON, unknown fields and oversized text in a version 1 file as no announcement", () => {
    expect(parseAnnouncementFile("{not json")).toEqual([]);
    expect(parseAnnouncementFile("[]")).toEqual([]);
    expect(parseAnnouncementFile(announcementJson({ url: "https://example.com" }))).toEqual([]);
    expect(parseAnnouncementFile(announcementJson({ title: "" }))).toEqual([]);
    expect(parseAnnouncementFile(announcementJson({ title: "t".repeat(81) }))).toEqual([]);
    expect(parseAnnouncementFile(announcementJson({ body: "b".repeat(601) }))).toEqual([]);
    expect(parseAnnouncementFile(announcementJson({ actionLabel: 7 }))).toEqual([]);
    expect(parseAnnouncementFile(announcementJson({ body: "b".repeat(9_000) }))).toEqual([]);
    expect(
      parseAnnouncementFile(JSON.stringify({ schemaVersion: 2, title: "t", body: "b" })),
    ).toEqual([]);
  });

  it("refuses a picture name that tries to leave the resources folder", () => {
    for (const picture of [
      "../secret.png",
      "..\\secret.png",
      "/etc/passwd.png",
      "nested/art.png",
      ".hidden.png",
      "art.svg",
      "art.png.exe",
    ]) {
      expect(parseAnnouncementFile(announcementJson({ picture }))).toEqual([]);
    }
  });

  it("hands the picture over as a data URL beside the text", async () => {
    const announcement = await loadBundledAnnouncements({
      announcementPath: "/app/resources/whats-new-announcement.json",
      ...memoryFiles({
        "/app/resources/whats-new-announcement.json": announcementJson({
          picture: "canvas.png",
          pictureAlt: "A mark on a block",
        }),
        "/app/resources/canvas.png": pngBytes(),
      }),
    });

    expect(announcement?.[0]?.title).toBe("Canvas comments");
    expect(announcement?.[0]?.picture?.alt).toBe("A mark on a block");
    expect(announcement?.[0]?.picture?.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from(pngBytes()).toString("base64")}`,
    );
  });

  it("drops an announcement whose picture is oversized, empty, missing or not what its name says", async () => {
    const load = (picture: Uint8Array | undefined) =>
      loadBundledAnnouncements({
        announcementPath: "/app/resources/whats-new-announcement.json",
        ...memoryFiles({
          "/app/resources/whats-new-announcement.json": announcementJson({ picture: "canvas.png" }),
          ...(picture === undefined ? {} : { "/app/resources/canvas.png": picture }),
        }),
      });

    expect(await load(pngBytes(MAX_ANNOUNCEMENT_PICTURE_BYTES + 1))).toBeUndefined();
    expect(await load(new Uint8Array(0))).toBeUndefined();
    expect(await load(undefined)).toBeUndefined();
    expect(await load(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeUndefined();
    expect(await load(pngBytes(MAX_ANNOUNCEMENT_PICTURE_BYTES))).toBeDefined();
  });

  it("includes the announcement only when the notes are due", async () => {
    const files = {
      "/app/whats-new.txt": "Octant 0.2.0\n\nThe dock keeps pins.",
      "/app/whats-new-announcement.json": announcementJson(),
    } as const;
    const io = memoryFiles(files);
    const load = (lastShown: string) =>
      loadBundledWhatsNew({
        currentVersion: "0.2.0",
        notesPath: "/app/whats-new.txt",
        statePath: "/data/state.json",
        readFile: async (path) =>
          path === "/data/state.json" ? encodeLastShownVersion(lastShown) : io.readFile(path),
        writeFile: async () => undefined,
        announcement: { path: "/app/whats-new-announcement.json", readBounded: io.readBounded },
      });

    const due = await load("0.1.0");
    expect(due.kind === "notes" ? due.announcements?.map((one) => one.title) : undefined).toEqual([
      "Canvas comments",
    ]);
    const settled = await load("0.2.0");
    expect(settled.kind === "notes" ? settled.announcements : "empty").toBeUndefined();
  });

  it("still answers with notes when the announcement is invalid", async () => {
    const io = memoryFiles({
      "/app/whats-new.txt": "Octant 0.2.0",
      "/app/whats-new-announcement.json": "{broken",
    });
    const answer = await loadBundledWhatsNew({
      currentVersion: "0.2.0",
      notesPath: "/app/whats-new.txt",
      statePath: "/data/state.json",
      readFile: async (path) =>
        path === "/data/state.json" ? encodeLastShownVersion("0.1.0") : io.readFile(path),
      writeFile: async () => undefined,
      announcement: { path: "/app/whats-new-announcement.json", readBounded: io.readBounded },
    });

    expect(answer).toEqual({
      kind: "notes",
      version: "0.2.0",
      text: "Octant 0.2.0",
      showAfterApply: true,
    });
  });

  it("asks the reader for no more than the cap, so an oversized picture or file is never loaded whole", async () => {
    const readBounded = vi.fn(async (path: string, maxBytes: number) => {
      const big = path.endsWith(".json")
        ? Buffer.from(announcementJson({ picture: "canvas.png" }))
        : pngBytes(maxBytes + 1);
      return big.subarray(0, maxBytes + 1);
    });
    expect(
      await loadBundledAnnouncements({ announcementPath: "/app/a.json", readBounded }),
    ).toBeUndefined();
    expect(readBounded).toHaveBeenCalledWith("/app/a.json", MAX_ANNOUNCEMENT_FILE_CHARS);
    expect(readBounded).toHaveBeenCalledWith("/app/canvas.png", MAX_ANNOUNCEMENT_PICTURE_BYTES);

    const oversizedJson = vi.fn(async (_path: string, maxBytes: number) =>
      new Uint8Array(maxBytes + 1).fill(0x20),
    );
    expect(
      await loadBundledAnnouncements({
        announcementPath: "/app/a.json",
        readBounded: oversizedJson,
      }),
    ).toBeUndefined();
    expect(oversizedJson).toHaveBeenCalledOnce();
  });

  it("reads only the cap plus one byte of a file far larger than the cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "whats-new-"));
    try {
      const path = join(directory, "huge.png");
      await writeFile(path, Buffer.alloc(MAX_ANNOUNCEMENT_PICTURE_BYTES * 8, 1));
      const bytes = await readAtMost(path, MAX_ANNOUNCEMENT_PICTURE_BYTES);
      expect(bytes.byteLength).toBe(MAX_ANNOUNCEMENT_PICTURE_BYTES + 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("version 2: several announcements", () => {
    it("reads one, three and five entries in order", () => {
      for (const count of [1, 3, 5]) {
        const entries = Array.from({ length: count }, (_, i) => entry(i + 1));
        expect(parseAnnouncementFile(setJson(entries)).map((one) => one.title)).toEqual(
          entries.map((one) => one.title),
        );
      }
    });

    it("skips an entry that is wrong by itself and keeps the rest in order", () => {
      const parsed = parseAnnouncementFile(
        setJson([
          entry(1),
          entry(2, { url: "https://example.com" }),
          entry(3, { title: "t".repeat(81) }),
          entry(4, { picture: "../escape.png" }),
          "not an object",
          null,
          [],
          entry(5, { actionLabel: "a".repeat(33) }),
          entry(6, { pictureAlt: "a".repeat(161) }),
          entry(7, { body: "b".repeat(601) }),
          entry(8),
        ]),
      );
      expect(parsed.map((one) => one.title)).toEqual(["Feature 1", "Feature 8"]);
    });

    it("accepts every field exactly at its limit", () => {
      const parsed = parseAnnouncementFile(
        setJson([
          {
            title: "t".repeat(80),
            body: "b".repeat(600),
            actionLabel: "a".repeat(32),
            pictureAlt: "p".repeat(160),
            picture: "x.png",
          },
        ]),
      );
      expect(parsed).toHaveLength(1);
    });

    it("gives nothing at all for bad JSON, an unknown top-level key or a wrong shape", () => {
      expect(parseAnnouncementFile("{nope")).toEqual([]);
      expect(parseAnnouncementFile(setJson([entry(1)], { extra: true }))).toEqual([]);
      expect(parseAnnouncementFile(setJson([entry(1)], { title: "stray" }))).toEqual([]);
      expect(
        parseAnnouncementFile(JSON.stringify({ schemaVersion: 2, announcements: entry(1) })),
      ).toEqual([]);
      expect(parseAnnouncementFile(JSON.stringify({ schemaVersion: 2 }))).toEqual([]);
      expect(parseAnnouncementFile(setJson([]))).toEqual([]);
      expect(parseAnnouncementFile(setJson([{ ...entry(1), schemaVersion: 2 }]))).toEqual([]);
    });

    it("holds five full entries, pretty-printed and heavily escaped, under the file cap", () => {
      const full = {
        title: "t".repeat(80),
        body: '"\n'.repeat(200),
        actionLabel: "a".repeat(32),
        pictureAlt: "p".repeat(160),
        picture: `${"n".repeat(60)}.png`,
      };
      const raw = JSON.stringify(
        { schemaVersion: 2, announcements: Array.from({ length: 5 }, () => full) },
        null,
        2,
      );
      expect(raw.length).toBeLessThanOrEqual(MAX_ANNOUNCEMENT_FILE_CHARS);
      expect(parseAnnouncementFile(raw)).toHaveLength(5);
      expect(
        parseAnnouncementFile(
          setJson([entry(1, { pad: "x".repeat(MAX_ANNOUNCEMENT_FILE_CHARS) })]),
        ),
      ).toEqual([]);
    });

    it("shows the first five valid entries when a file lists more", async () => {
      const entries = Array.from({ length: 8 }, (_, i) =>
        i === 1 ? entry(i + 1, { extra: 1 }) : entry(i + 1),
      );
      const shown = await loadBundledAnnouncements({
        announcementPath: FILE,
        ...memoryFiles({ [FILE]: setJson(entries) }),
      });
      expect(MAX_ANNOUNCEMENTS).toBe(5);
      expect(shown?.map((one) => one.title)).toEqual([
        "Feature 1",
        "Feature 3",
        "Feature 4",
        "Feature 5",
        "Feature 6",
      ]);
    });

    it("skips an entry whose picture is missing, oversized or the wrong format and keeps the others", async () => {
      const shown = await loadBundledAnnouncements({
        announcementPath: FILE,
        ...memoryFiles({
          [FILE]: setJson([
            entry(1, { picture: "ok.png", pictureAlt: "Fine" }),
            entry(2, { picture: "missing.png" }),
            entry(3, { picture: "big.png" }),
            entry(4, { picture: "fake.png" }),
            entry(5),
          ]),
          [`${FOLDER}/ok.png`]: pngBytes(),
          [`${FOLDER}/big.png`]: pngBytes(MAX_ANNOUNCEMENT_PICTURE_BYTES + 1),
          [`${FOLDER}/fake.png`]: new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
        }),
      });
      expect(shown?.map((one) => one.title)).toEqual(["Feature 1", "Feature 5"]);
      expect(shown?.[0]?.picture?.alt).toBe("Fine");
      expect(shown?.[1]?.picture).toBeUndefined();
    });

    it("reads pictures only for the entries that will be shown, each under the picture cap", async () => {
      const files: Record<string, string | Uint8Array> = {
        [FILE]: setJson(
          Array.from({ length: 7 }, (_, i) => entry(i + 1, { picture: `p${i + 1}.png` })),
        ),
      };
      for (let i = 1; i <= 7; i += 1) files[`${FOLDER}/p${i}.png`] = pngBytes();
      const io = memoryFiles(files);
      const readBounded = vi.fn(io.readBounded);

      const shown = await loadBundledAnnouncements({ announcementPath: FILE, readBounded });

      expect(shown).toHaveLength(5);
      const pictureReads = readBounded.mock.calls.filter(([path]) => path.endsWith(".png"));
      expect(pictureReads.map(([path]) => path)).toEqual(
        [1, 2, 3, 4, 5].map((i) => `${FOLDER}/p${i}.png`),
      );
      for (const [, maxBytes] of pictureReads) {
        expect(maxBytes).toBe(MAX_ANNOUNCEMENT_PICTURE_BYTES);
      }
    });

    it("answers with no announcements, not an error, when nothing in the file is valid", async () => {
      expect(
        await loadBundledAnnouncements({
          announcementPath: FILE,
          ...memoryFiles({ [FILE]: setJson([entry(1, { picture: "gone.png" }), "x"]) }),
        }),
      ).toBeUndefined();
      expect(
        await loadBundledAnnouncements({
          announcementPath: FILE,
          readBounded: async () => {
            throw new Error("unreadable");
          },
        }),
      ).toBeUndefined();
    });

    it("carries the shown entries to the renderer as one list on the notes", async () => {
      const io = memoryFiles({
        "/app/whats-new.txt": "Octant 0.2.0",
        [FILE]: setJson([entry(1), entry(2)]),
      });
      const answer = await loadBundledWhatsNew({
        currentVersion: "0.2.0",
        notesPath: "/app/whats-new.txt",
        statePath: "/data/state.json",
        readFile: async (path) =>
          path === "/data/state.json" ? encodeLastShownVersion("0.1.0") : io.readFile(path),
        writeFile: async () => undefined,
        announcement: { path: FILE, readBounded: io.readBounded },
      });
      expect(answer).toEqual({
        kind: "notes",
        version: "0.2.0",
        text: "Octant 0.2.0",
        showAfterApply: true,
        announcements: [
          { title: "Feature 1", body: "Body 1." },
          { title: "Feature 2", body: "Body 2." },
        ],
      });
    });
  });
});
