import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";
import { lazy, Suspense } from "react";
import type { ComposerExtensionSelection } from "../composer/composerExtensionSelection";

const McpSignInNotices = lazy(() =>
  import("./McpSignInNotices").then(({ McpSignInNotices }) => ({ default: McpSignInNotices })),
);

export interface McpSignInNoticeProps {
  /** Absent for a thread shown read-only. */
  readonly client: ExtensionClient | undefined;
  readonly mode: OctantMode;
  readonly threadId: string | undefined;
  /** The composer's selections, which the next message carries. */
  readonly receipts: ReadonlyArray<ComposerExtensionSelection>;
  /** The selections a Retry of the latest turn would send again. */
  readonly retrySelections?: ReadonlyArray<ExtensionSelection> | undefined;
  readonly turnActive: boolean;
  readonly className: string;
}

/**
 * The sign-in an MCP server of this thread is waiting for, in the thread. Only
 * a client that may sign in asks, so every other device loads and shows nothing.
 */
export function McpSignInNotice(props: McpSignInNoticeProps) {
  const { client, threadId } = props;
  if (
    threadId === undefined ||
    client?.toolGrantsAvailable !== true ||
    client.mcpServersAwaitingSignIn === undefined
  )
    return null;
  return (
    <Suspense fallback={null}>
      <McpSignInNotices key={threadId} {...props} client={client} threadId={threadId} />
    </Suspense>
  );
}
