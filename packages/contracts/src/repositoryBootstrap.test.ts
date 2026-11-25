import { describe, expect, it } from "vitest";
import {
  REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES,
  decodeRepositoryBootstrapLandFilesRequest,
  decodeRepositoryBootstrapOperationResponse,
  decodeRepositoryBootstrapStartCloneRequest,
} from "./repositoryBootstrap";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SHA = "a".repeat(64);

describe("repository bootstrap contracts", () => {
  it("decodes a valid clone start request and refuses excess properties", () => {
    const decoded = decodeRepositoryBootstrapStartCloneRequest({
      operationId: OPERATION_ID,
      remoteUrl: "git@github.com:org/repo.git",
      transport: "ssh",
      destinationPath: "~/repo",
    });
    expect(decoded.transport).toBe("ssh");
    expect(() =>
      decodeRepositoryBootstrapStartCloneRequest({
        operationId: OPERATION_ID,
        remoteUrl: "git@github.com:org/repo.git",
        transport: "ssh",
        destinationPath: "~/repo",
        extra: true,
      }),
    ).toThrow();
  });

  it("refuses file payloads with special permission bits or sizes above the cap", () => {
    expect(() =>
      decodeRepositoryBootstrapLandFilesRequest({
        operationId: OPERATION_ID,
        files: [
          {
            relativePath: ".env",
            bytes: 10,
            sha256: SHA,
            mode: 0o4755,
            contentBase64: "QQ==",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      decodeRepositoryBootstrapLandFilesRequest({
        operationId: OPERATION_ID,
        files: [
          {
            relativePath: ".env",
            bytes: REPOSITORY_BOOTSTRAP_MAX_FILE_BYTES + 1,
            sha256: SHA,
            mode: 0o600,
            contentBase64: "QQ==",
          },
        ],
      }),
    ).toThrow();
  });

  it("decodes discriminated clone operation states", () => {
    const cloned = decodeRepositoryBootstrapOperationResponse({
      operation: {
        state: "cloned",
        operationId: OPERATION_ID,
        transport: "https",
        destinationPath: "~/repo",
        canonicalDestination: "/home/dev/repo",
        receiptId: RECEIPT_ID,
        projectName: "repo",
        updatedAt: "2026-11-24T20:00:00.000Z",
      },
    });
    expect(cloned.operation.state).toBe("cloned");

    const failed = decodeRepositoryBootstrapOperationResponse({
      operation: {
        state: "failed",
        operationId: OPERATION_ID,
        transport: "ssh",
        destinationPath: "~/repo",
        code: "host-key-unverified",
        message: "The remote SSH host key is not in known_hosts.",
        updatedAt: "2026-11-24T20:00:00.000Z",
      },
    });
    expect(failed.operation.state).toBe("failed");
  });
});
