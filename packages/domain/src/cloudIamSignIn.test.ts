import {
  decodeCloudAccountId,
  decodeCloudIamRegion,
  decodeCloudIamStartUrl,
  decodeCloudRoleName,
} from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import { amazonBedrockCloudIamDescriptor } from "./cloudIamSignIn";

describe("Amazon Bedrock cloud sign-in", () => {
  it("builds the broker descriptor from configuration alone, signing only model requests in the instance's region", () => {
    const cloudIam = {
      startUrl: decodeCloudIamStartUrl("https://contoso.awsapps.com/start"),
      ssoRegion: decodeCloudIamRegion("us-east-1"),
      accountId: decodeCloudAccountId("123456789012"),
      roleName: decodeCloudRoleName("BedrockInvoke"),
    };
    expect(
      amazonBedrockCloudIamDescriptor({ region: decodeCloudIamRegion("eu-central-1"), cloudIam }),
    ).toEqual({
      descriptorId: "amazon-bedrock-cloud-iam",
      termsId: "amazon-bedrock-cloud-iam-1",
      flow: "device-code",
      source: cloudIam,
      scope: {
        partition: "aws",
        region: "eu-central-1",
        service: "bedrock",
        host: "bedrock-runtime.eu-central-1.amazonaws.com",
        pathPrefix: "/model/",
        method: "POST",
      },
    });
  });
});
