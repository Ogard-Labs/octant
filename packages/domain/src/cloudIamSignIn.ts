import type {
  CloudIamRegion,
  CloudIamSigningScope,
  CloudIamSourceIdentity,
} from "@octant/contracts";

/**
 * Cloud sign-in for Amazon Bedrock, as product data the server, the driver,
 * and the host-local command share. The person signs in at the
 * organization's single sign-on portal with a device code; the host
 * credential broker keeps that session and the temporary credentials it
 * mints for one account and role, and signs each model request itself. The
 * signing scope is the driver kind's own: the region picks the host, and
 * nothing in configuration names another service, host, path, or method.
 */
export const AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN = {
  descriptorId: "amazon-bedrock-cloud-iam",
  termsId: "amazon-bedrock-cloud-iam-1",
  /** What the command calls the account before and after the sign-in. */
  accountLabel: "Cloud account",
  termsSummary:
    "Octant signs you in at your organization's single sign-on portal and keeps the sign-in, and the temporary credentials it gives for this account and role, in this computer's credential broker. The broker signs each request to this Amazon Bedrock endpoint itself; Octant's server never holds a key. Requests run as that role, under your organization's policies. Sign out removes this computer's sign-in and asks the portal to end the session.",
  /**
   * Printed beside the code by the host-local command. A device code is the
   * easier sign-in to phish: someone who sends a person their own code gets
   * a sign-in as that person when it is entered.
   */
  deviceCodeWarning:
    "Enter this code only because you just ran this command on this computer. Never enter a sign-in code someone sent you.",
  service: "bedrock",
  pathPrefix: "/model/",
  method: "POST",
} as const;

/** The Bedrock runtime host in a region; the only host a Bedrock grant signs for. */
export function amazonBedrockRuntimeHost(region: CloudIamRegion): string {
  return `bedrock-runtime.${String(region)}.amazonaws.com`;
}

/** What a Bedrock instance's grant may sign: model requests in its own region. */
export function amazonBedrockSigningScope(region: CloudIamRegion): CloudIamSigningScope {
  return {
    partition: "aws",
    region,
    service: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.service,
    host: amazonBedrockRuntimeHost(region),
    pathPrefix: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.pathPrefix,
    method: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.method,
  };
}

/**
 * The broker descriptor a Bedrock sign-in begins with, built from the
 * instance's configuration alone: the portal, account, and role it signs in
 * for, and the scope its grant will sign. The only flow is the portal's
 * device authorization.
 */
export interface CloudIamSignInDescriptor {
  readonly descriptorId: typeof AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.descriptorId;
  readonly termsId: typeof AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.termsId;
  readonly flow: "device-code";
  readonly source: CloudIamSourceIdentity;
  readonly scope: CloudIamSigningScope;
}

export function amazonBedrockCloudIamDescriptor(configuration: {
  readonly region: CloudIamRegion;
  readonly cloudIam: CloudIamSourceIdentity;
}): CloudIamSignInDescriptor {
  return {
    descriptorId: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.descriptorId,
    termsId: AMAZON_BEDROCK_CLOUD_IAM_SIGN_IN.termsId,
    flow: "device-code",
    source: configuration.cloudIam,
    scope: amazonBedrockSigningScope(configuration.region),
  };
}
