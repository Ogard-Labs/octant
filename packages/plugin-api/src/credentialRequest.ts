/**
 * A plugin declares a bounded request without receiving its credential. The
 * host fixes the destination, attaches authentication, refuses redirects, and
 * owns consent, expiry and execution. An agent cannot supply this descriptor.
 */
export interface CredentialOperation {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
  readonly consumer: string;
  readonly actionLabel: string;
  readonly request: {
    readonly url: string;
    readonly authorization: "bearer" | "raw";
  } & (
    | { readonly method: "GET"; readonly body?: never }
    | { readonly method?: "POST"; readonly body: string }
  );
  /** Status checks cancel the response body; otherwise bounded JSON reaches accepted. */
  readonly response?: "status-only";
  /** Only a non-sensitive status is returned to the agent in this first slice. */
  readonly accepted: (body: unknown) => boolean;
}
