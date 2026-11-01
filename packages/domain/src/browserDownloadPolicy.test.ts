import { describe, expect, it } from "vitest";
import {
  browserDownloadNameIsExecutable,
  browserDownloadQuestion,
  numberedBrowserDownloadName,
  refuseBrowserDownloadType,
  safeBrowserDownloadName,
  sniffBrowserDownload,
} from "./browserDownloadPolicy";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("sniffBrowserDownload", () => {
  it("reads the type from the bytes", () => {
    expect(sniffBrowserDownload(text("%PDF-1.7\n"))).toEqual({
      mediaType: "application/pdf",
      executable: false,
    });
    expect(sniffBrowserDownload(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d)).mediaType).toBe("image/png");
    expect(sniffBrowserDownload(text("a,b\n1,2\n")).mediaType).toBe("text/plain");
    expect(sniffBrowserDownload(bytes(0, 1, 2, 3, 250)).mediaType).toBe("application/octet-stream");
  });

  it("marks ELF, PE and Mach-O as executable whatever the name says", () => {
    expect(sniffBrowserDownload(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1)).executable).toBe(true);
    expect(sniffBrowserDownload(text("MZ\u0090\u0000")).executable).toBe(true);
    expect(sniffBrowserDownload(bytes(0xcf, 0xfa, 0xed, 0xfe, 7)).executable).toBe(true);
    expect(sniffBrowserDownload(bytes(0xfe, 0xed, 0xfa, 0xce)).executable).toBe(true);
    expect(refuseBrowserDownloadType("report.pdf", bytes(0x7f, 0x45, 0x4c, 0x46))).toBe(
      "executable",
    );
  });

  it("leaves other files alone", () => {
    expect(refuseBrowserDownloadType("report.pdf", text("%PDF-1.7"))).toBeUndefined();
  });
});

describe("names", () => {
  it("refuses installer and script names", () => {
    for (const name of [
      "a.app",
      "a.PKG",
      "a.dmg",
      "a.exe",
      "a.msi",
      "a.bat",
      "a.cmd",
      "a.command",
    ]) {
      expect(browserDownloadNameIsExecutable(name)).toBe(true);
    }
    for (const name of ["a.sh", "a.scpt", "a.jar", "a.deb", "a.rpm", "a.AppImage"]) {
      expect(browserDownloadNameIsExecutable(name)).toBe(true);
    }
    expect(browserDownloadNameIsExecutable("a.pdf")).toBe(false);
  });

  it("reduces a suggested name to a safe basename", () => {
    expect(safeBrowserDownloadName("../../etc/passwd")).toBe("passwd");
    expect(safeBrowserDownloadName("C:\\x\\y\\report.pdf")).toBe("report.pdf");
    expect(safeBrowserDownloadName(".bashrc")).toBe("bashrc");
    expect(safeBrowserDownloadName("..")).toBe("download");
    expect(safeBrowserDownloadName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(safeBrowserDownloadName("")).toBe("download");
    const long = safeBrowserDownloadName(`${"x".repeat(400)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("numbers a repeated name before its extension", () => {
    expect(numberedBrowserDownloadName("report.pdf", 1)).toBe("report.pdf");
    expect(numberedBrowserDownloadName("report.pdf", 2)).toBe("report (2).pdf");
    expect(numberedBrowserDownloadName("notes", 3)).toBe("notes (3)");
  });
});

describe("browserDownloadQuestion", () => {
  it("names the file, its size, its type, and the site", () => {
    expect(
      browserDownloadQuestion("https://example.com", {
        name: "report.pdf",
        sizeBytes: 1_258_291,
        mediaType: "application/pdf",
      }),
    ).toBe(
      "Let the agent save report.pdf (1.2 MB, PDF) from https://example.com into this thread's workspace?",
    );
  });
});
