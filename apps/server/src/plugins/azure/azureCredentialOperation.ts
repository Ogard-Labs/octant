import type { CredentialOperation } from "@octant/plugin-api/credential-request";

/** One ARM read. No URL, tenant, subscription or command comes from the model. */
export const azureCredentialOperation: CredentialOperation = {
  id: "azure-subscriptions-check",
  label: "Azure Resource Manager access token",
  consumer: "Azure Resource Manager",
  actionLabel: "Check subscriptions access",
  reason:
    "Use an unexpired short-lived Resource Manager token for one subscriptions GET. The token's account and RBAC may be broader; Octant sends only this fixed read, follows no redirect and returns status only. Azure CLI credentials remain unavailable.",
  request: {
    method: "GET",
    url: "https://management.azure.com/subscriptions?api-version=2022-12-01",
    authorization: "bearer",
  },
  accepted: (body) =>
    typeof body === "object" && body !== null && "value" in body && Array.isArray(body.value),
};
