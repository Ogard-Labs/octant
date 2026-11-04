import type { CredentialOperation } from "@octant/plugin-api/credential-request";

/** Fixed read-only query. Neither the model nor a card submission supplies a URL or body. */
export const linearCredentialOperation: CredentialOperation = {
  id: "linear-account-check",
  label: "Linear API token",
  reason: "Check that this token can access your Linear account.",
  consumer: "Linear",
  actionLabel: "Check access",
  request: {
    url: "https://api.linear.app/graphql",
    body: JSON.stringify({ query: "query OctantCredentialCheck { viewer { id } }" }),
    authorization: "raw",
  },
  accepted: (body) => {
    if (typeof body !== "object" || body === null || "errors" in body || !("data" in body))
      return false;
    const data = body.data;
    if (typeof data !== "object" || data === null || !("viewer" in data)) return false;
    const viewer = data.viewer;
    return (
      typeof viewer === "object" &&
      viewer !== null &&
      "id" in viewer &&
      typeof viewer.id === "string" &&
      viewer.id.length > 0
    );
  },
};
