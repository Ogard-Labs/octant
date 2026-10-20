export interface InboxEmptyState {
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
}

/**
 * With no paired computer the Inbox has nothing to count or compose against, so
 * it shows one next step instead. Undefined until the saved hosts have been
 * read, so a returning person never sees the first-run card flash.
 */
export function inboxEmptyState(input: {
  readonly hosts: ReadonlyArray<unknown>;
  readonly hostsLoaded: boolean;
}): InboxEmptyState | undefined {
  if (!input.hostsLoaded || input.hosts.length > 0) return undefined;
  return {
    title: "Pair your first computer",
    body: "On your computer, open Settings → Remote access and scan the QR code shown there.",
    actionLabel: "Scan QR code",
  };
}
