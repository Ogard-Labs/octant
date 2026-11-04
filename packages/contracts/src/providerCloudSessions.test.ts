import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  decodeProviderCloudRequest,
  decodeProviderCloudResponse,
  ProviderCloudCreateInput,
} from "./providerCloudSessions";

const start = {
  kind: "start",
  jobId: "a7550000-0000-4000-8000-000000000001",
  threadId: "a7550000-0000-4000-8000-000000000002",
  instanceId: "a7550000-0000-4000-8000-000000000003",
  modelId: "fixture-model",
  input: "Synthetic reviewed input",
  reviewedInputDigest: "a".repeat(64),
  cloudExecutionConsent: true,
};

describe("provider cloud boundary", () => {
  it("refuses inherited files, missing consent and unbounded text instead of granting remote authority", () => {
    expect(decodeProviderCloudRequest(start)).toMatchObject(start);
    expect(() => decodeProviderCloudRequest({ ...start, files: ["/private/fixture"] })).toThrow();
    expect(() => decodeProviderCloudRequest({ ...start, cloudExecutionConsent: false })).toThrow();
    expect(() => decodeProviderCloudRequest({ ...start, input: "x".repeat(16_001) })).toThrow();
    expect(() =>
      decodeProviderCloudRequest({
        ...start,
        acknowledgedUnknownJobs: [{ jobId: start.jobId, expectedVersion: -1 }],
      }),
    ).toThrow();
    expect(() =>
      decodeProviderCloudResponse({
        status: "ready",
        profiles: [],
        jobs: [],
        credential: "forbidden",
      }),
    ).toThrow();
  });
  it("keeps reviewed task text exactly as reviewed, surrounding whitespace included, and refuses blank text", () => {
    const pasted = "  Indented reviewed task\n";
    expect(decodeProviderCloudRequest({ ...start, input: pasted })).toMatchObject({
      input: pasted,
    });
    expect(() => decodeProviderCloudRequest({ ...start, input: " \n\t" })).toThrow();
    const decodeCreate = Schema.decodeUnknownSync(ProviderCloudCreateInput);
    const create = { jobId: start.jobId, modelId: start.modelId };
    expect(decodeCreate({ ...create, text: pasted })).toMatchObject({ text: pasted });
    expect(() => decodeCreate({ ...create, text: "   " })).toThrow();
  });
});
