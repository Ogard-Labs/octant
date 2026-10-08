import { describe, expect, it } from "vitest";
import {
  decodeReplicaStoreS3Settings,
  decodeReplicaStoreSettings,
  decodeReplicaStoreSettingsCommand,
  decodeReplicaStoreSettingsResult,
  decodeReplicaStoreSettingsView,
} from "./replicaStoreSettings";

const updatedAt = "2026-10-07T12:00:00.000Z";
const credentialRef = "6b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
const bucket = {
  endpoint: "https://s3.example.test",
  region: "eu-north-1",
  bucket: "octant-sync",
  prefix: "laptop",
  addressing: "path",
} as const;

describe("replica store settings contracts", () => {
  it("starts with no store and sync off", () => {
    const settings = decodeReplicaStoreSettings({
      kind: "replica-store-settings",
      store: { kind: "none" },
      syncOn: false,
      version: 0,
      updatedAt,
    });

    expect(settings.store).toEqual({ kind: "none" });
    expect(settings.syncOn).toBe(false);
  });

  it("refuses sync turned on with no store", () => {
    expect(() =>
      decodeReplicaStoreSettings({
        kind: "replica-store-settings",
        store: { kind: "none" },
        syncOn: true,
        version: 1,
        updatedAt,
      }),
    ).toThrow();
  });

  it("refuses a plaintext http endpoint", () => {
    expect(() =>
      decodeReplicaStoreS3Settings({ ...bucket, endpoint: "http://s3.example.test" }),
    ).toThrow();
  });

  it("refuses an endpoint that carries a path, a query, or credentials", () => {
    for (const endpoint of [
      "https://s3.example.test/base",
      "https://s3.example.test/?region=x",
      "https://user:secret@s3.example.test",
    ]) {
      expect(() => decodeReplicaStoreS3Settings({ ...bucket, endpoint })).toThrow();
    }
  });

  it("refuses a link-local endpoint, including instance metadata, but keeps loopback and private hosts", () => {
    for (const endpoint of [
      "https://169.254.169.254",
      "https://2852039166",
      "https://[fe80::1]",
      "https://[febf::1]:9000",
      "https://[::ffff:169.254.169.254]",
    ]) {
      expect(() => decodeReplicaStoreS3Settings({ ...bucket, endpoint })).toThrow();
    }
    for (const endpoint of [
      "https://127.0.0.1:9000",
      "https://[::1]:9000",
      "https://10.0.0.5",
      "https://192.168.1.20:9000",
      "https://minio.local",
    ]) {
      expect(decodeReplicaStoreS3Settings({ ...bucket, endpoint }).endpoint).toBe(endpoint);
    }
  });

  it("refuses an access key or secret written into a bucket's settings", () => {
    expect(() => decodeReplicaStoreS3Settings({ ...bucket, accessKeyId: "AKIAEXAMPLE" })).toThrow();
    expect(() =>
      decodeReplicaStoreSettings({
        kind: "replica-store-settings",
        store: {
          kind: "s3",
          settings: bucket,
          credentialRef,
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
        syncOn: false,
        version: 1,
        updatedAt,
      }),
    ).toThrow();
  });

  it("refuses a virtual-host bucket that is not a DNS-safe name", () => {
    expect(() =>
      decodeReplicaStoreS3Settings({
        ...bucket,
        bucket: "Octant_Sync",
        addressing: "virtual-host",
      }),
    ).toThrow();
    expect(
      decodeReplicaStoreS3Settings({ ...bucket, bucket: "Octant_Sync", addressing: "path" }).bucket,
    ).toBe("Octant_Sync");
  });

  it("refuses virtual-host addressing against an IP-address endpoint, which has no host to prefix", () => {
    for (const endpoint of ["https://10.0.0.5", "https://127.0.0.1:9000", "https://[::1]:9000"]) {
      expect(() =>
        decodeReplicaStoreS3Settings({ ...bucket, endpoint, addressing: "virtual-host" }),
      ).toThrow("Virtual-host addressing needs an endpoint with a DNS name, not an IP address.");
      expect(
        decodeReplicaStoreS3Settings({ ...bucket, endpoint, addressing: "path" }).endpoint,
      ).toBe(endpoint);
    }
    expect(
      decodeReplicaStoreS3Settings({
        ...bucket,
        endpoint: "https://minio.local",
        addressing: "virtual-host",
      }).addressing,
    ).toBe("virtual-host");
  });

  it("refuses a prefix that climbs out of the bucket", () => {
    expect(() => decodeReplicaStoreS3Settings({ ...bucket, prefix: "../other" })).toThrow();
  });

  it("carries a folder choice as a browser candidate, never a path", () => {
    expect(() =>
      decodeReplicaStoreSettingsCommand({
        schemaVersion: 1,
        kind: "choose-synced-folder",
        mode: "work",
        candidateId: "88888888-8888-4888-8888-888888888888",
        folder: "/Users/example/Sync",
        expectedVersion: 0,
      }),
    ).toThrow();
  });

  it("accepts a key pair only inside the command that saves it", () => {
    const command = decodeReplicaStoreSettingsCommand({
      schemaVersion: 1,
      kind: "configure-s3",
      settings: bucket,
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret/example+key" },
      expectedVersion: 0,
    });
    expect(command.kind).toBe("configure-s3");

    expect(() =>
      decodeReplicaStoreSettingsView({
        kind: "replica-store-settings-view",
        store: {
          kind: "s3",
          settings: bucket,
          credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret/example+key" },
        },
        syncOn: false,
        version: 1,
        hostId: "local",
        mode: "work",
        credentialStore: "available",
        replicaMember: false,
      }),
    ).toThrow();
  });

  it("reads a Test connection answer as a typed outcome", () => {
    const result = decodeReplicaStoreSettingsResult({
      kind: "replica-store-connection-tested",
      outcome: "unauthorized",
      message: "The bucket refused the access key.",
    });
    expect(result).toMatchObject({ outcome: "unauthorized" });
  });
});
