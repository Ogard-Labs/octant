import type { CredentialOperation } from "@octant/plugin-api/credential-request";

/** Each admitted integration owns its registrations; discovery never grants use. */
export class IntegrationCredentialOperations {
  readonly #operations = new Map<string, CredentialOperation>();

  register(
    operation: CredentialOperation,
  ): { readonly kind: "registered"; readonly release: () => void } | { readonly kind: "refused" } {
    if (this.#operations.size >= 16 || this.#operations.has(operation.id))
      return { kind: "refused" };
    try {
      const url = new URL(operation.request.url);
      if (
        !/^[a-z][a-z0-9-]{0,79}$/.test(operation.id) ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        operation.request.url.length > 2048 ||
        (operation.request.method === "GET"
          ? operation.request.body !== undefined
          : (operation.request.method !== undefined && operation.request.method !== "POST") ||
            typeof operation.request.body !== "string" ||
            operation.request.body.length > 16_384) ||
        !["bearer", "raw"].includes(operation.request.authorization) ||
        [operation.label, operation.reason, operation.consumer, operation.actionLabel].some(
          (value) => typeof value !== "string" || value.length === 0 || value.length > 512,
        ) ||
        typeof operation.accepted !== "function"
      )
        return { kind: "refused" };
      const captured = Object.freeze({
        id: operation.id,
        label: operation.label,
        reason: operation.reason,
        consumer: operation.consumer,
        actionLabel: operation.actionLabel,
        request: Object.freeze({ ...operation.request }),
        accepted: operation.accepted,
      });
      this.#operations.set(captured.id, captured);
      return {
        kind: "registered",
        release: () => {
          if (this.#operations.get(captured.id) === captured) this.#operations.delete(captured.id);
        },
      };
    } catch {
      return { kind: "refused" };
    }
  }

  list(): ReadonlyArray<CredentialOperation> {
    return [...this.#operations.values()];
  }
}
