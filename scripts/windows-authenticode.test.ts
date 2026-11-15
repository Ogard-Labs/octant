import { describe, expect, it } from "vitest";
import { OCTANT_WINDOWS_PUBLISHER } from "../apps/desktop/src/windowsInstallerUpdate";
import { programsToSign, releaseSignatureFailures } from "./windows-authenticode";

const ours = (path: string) => ({
  path,
  report: { kind: "read", status: "Valid", publisher: OCTANT_WINDOWS_PUBLISHER } as const,
});

describe("signing a Windows release", () => {
  it("signs every program Windows does not already accept, and keeps another publisher's valid signature", () => {
    expect(
      programsToSign([
        { path: "Octant.exe", report: { kind: "read", status: "NotSigned", publisher: null } },
        {
          path: "d3dcompiler_47.dll",
          report: { kind: "read", status: "Valid", publisher: "Microsoft Corporation" },
        },
        { path: "ffmpeg.dll", report: { kind: "read", status: "HashMismatch", publisher: null } },
        { path: "pty.node", report: { kind: "unavailable" } },
      ]),
    ).toEqual(["Octant.exe", "ffmpeg.dll", "pty.node"]);
  });

  it("ships only when every program is valid and every program it signed names Octant's publisher", () => {
    const signed = new Set(["Octant.exe", "Uninstall Octant.exe"]);
    expect(
      releaseSignatureFailures(
        [
          ours("Octant.exe"),
          ours("Uninstall Octant.exe"),
          {
            path: "d3dcompiler_47.dll",
            report: { kind: "read", status: "Valid", publisher: "Microsoft Corporation" },
          },
        ],
        signed,
      ),
    ).toEqual([]);

    expect(
      releaseSignatureFailures(
        [
          {
            path: "Octant.exe",
            report: { kind: "read", status: "Valid", publisher: "Someone Else" },
          },
          { path: "ffmpeg.dll", report: { kind: "read", status: "NotSigned", publisher: null } },
          { path: "pty.node", report: { kind: "unavailable" } },
        ],
        signed,
      ),
    ).toEqual([
      `Octant.exe: not signed by ${OCTANT_WINDOWS_PUBLISHER} (other-publisher).`,
      "ffmpeg.dll: signature status NotSigned.",
      "pty.node: the signature could not be read.",
      "Uninstall Octant.exe: expected a signed program and found none.",
    ]);
  });
});
