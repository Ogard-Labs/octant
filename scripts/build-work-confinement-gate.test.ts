import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WORK_CONFINEMENT_BROKER_BUNDLE_ID,
  WORK_CONFINEMENT_GATE_BUNDLE_ID,
  workConfinementBuildCommands,
} from "./build-work-confinement-gate";

describe("Work confinement feasibility build", () => {
  it("pins the disposable proof identities", () => {
    expect(WORK_CONFINEMENT_GATE_BUNDLE_ID).toBe("app.octant.desktop.work-confinement-gate");
    expect(WORK_CONFINEMENT_BROKER_BUNDLE_ID).toBe(
      "app.octant.desktop.work-confinement-gate.broker",
    );
  });

  it("builds only Apple Silicon macOS 14 proof executables", () => {
    const commands = workConfinementBuildCommands("/repo", "/tmp/build");

    expect(commands.map((command) => command.output)).toEqual([
      "/tmp/build/OctantWorkConfinementGate",
      "/tmp/build/OctantWorkConfinementBroker",
      "/tmp/build/OctantWorkConfinementForeignClient",
    ]);
    for (const command of commands) {
      expect(command.args.slice(0, 4)).toEqual([
        "swiftc",
        "-O",
        "-target",
        "arm64-apple-macos14.0",
      ]);
      expect(command.args).toContain(
        "/repo/apps/desktop/native/work-confinement-gate/OctantWorkConfinementProtocol.swift",
      );
      expect(command.args).toContain("-framework");
      expect(command.args).toContain("Security");
    }

    expect(commands[0]?.args).toContain("AppKit");
    expect(commands[1]?.args).not.toContain("AppKit");
    expect(commands[2]?.args).not.toContain("AppKit");
  });

  it("keeps the XPC protocol typed, bounded, and explicitly allowlisted", async () => {
    const source = await readFile(
      fileURLToPath(
        new URL(
          "../apps/desktop/native/work-confinement-gate/OctantWorkConfinementProtocol.swift",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(source).toContain("final class OOConfinementAuthority: NSObject, NSSecureCoding");
    expect(source).toContain("enum OOConfinementAuthorityMode: Int");
    expect(source).toContain("case authenticationOnly = 0");
    expect(source).toContain("case adoptSelectedRoot = 1");
    expect(source).toContain("case resumePersisted = 2");
    expect(source).toContain("let mode: OOConfinementAuthorityMode");
    expect(source).toContain("let transientBookmark: Data?");
    expect(source).toContain("transientBookmark.count <= 1_048_576");
    expect(source).not.toContain("let selectedRootURL: URL?");
    expect(source).not.toContain("let bookmark: Data");
    expect(source).toContain("let protocolVersion: Int");
    expect(source).toContain("let probeID: String");
    expect(source).toContain("let destinationPathComponents: [String]?");
    expect(source).toContain("capability.count == 32");
    expect(source).toContain("payload.count <= 1_048_576");
    expect(source).toContain("payload.count <= 65_536");
    expect(source).toContain("components.count <= 64");
    expect(source).toContain("component.utf8.count <= 255");
    expect(source).toContain("setClasses");
    expect(source).not.toContain("[String: Any]");
  });

  it("keeps broker persistence diagnostics fixed and path-free", async () => {
    const source = await readFile(
      fileURLToPath(
        new URL(
          "../apps/desktop/native/work-confinement-gate/OctantWorkConfinementBroker.swift",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(source).toContain("BrokerStateDirectoryUnavailable");
    expect(source).toContain("BrokerStateCreateFailed");
    expect(source).toContain("BrokerStateEncodeFailed");
    expect(source).toContain("BrokerStateWriteFailed");
    expect(source).toContain("BrokerStatePermissionsFailed");
    expect(source).toContain("options: .withoutUI");
    expect(source).toContain("options: .withSecurityScope");
    expect(source).not.toContain("localizedDescription");
  });

  it("sanitizes XPC establishment errors without emitting descriptions", async () => {
    const source = await readFile(
      fileURLToPath(
        new URL(
          "../apps/desktop/native/work-confinement-gate/OctantWorkConfinementGate.swift",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(source).toContain("NSCocoaErrorDomain");
    expect(source).toContain("ConnectionError");
    expect(source).toContain("options: .minimalBookmark");
    expect(source).toContain("exit(EXIT_SUCCESS)");
    expect(source).not.toContain("localizedDescription");
  });
});
