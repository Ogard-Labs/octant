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
    readonly body: string;
    readonly authorization: "bearer" | "raw";
  };
  /** Only a non-sensitive status is returned to the agent in this first slice. */
  readonly accepted: (body: unknown) => boolean;
}
