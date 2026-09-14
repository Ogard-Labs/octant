import type {
  CodeCheckoutId,
  CodeFileChangeNotice,
  CodeRelativePath,
  CodeThreadId,
} from "@octant/contracts";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { FolderTree, RefreshCw } from "lucide-react";
import { CodeFileExplorer, type CodeFileExplorerEntry } from "./CodeFileExplorer";
import { useCodeFileListingController } from "./useCodeFileListingController";
import { OctantButton } from "../ui/base/OctantButton";

export interface CodeFileExplorerPanelProps {
  readonly threadId?: CodeThreadId | undefined;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly directory?: CodeRelativePath | undefined;
  readonly onOpenFile: (entry: Extract<CodeFileExplorerEntry, { readonly kind: "file" }>) => void;
  readonly selectedPath?: CodeRelativePath | undefined;
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly client?: CodeFileListingClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Called for every host-reported change, so an open editor can reload. */
  readonly onFilesChanged?: (notice: CodeFileChangeNotice) => void;
}

/**
 * Mountable container for the repository file explorer.
 *
 * A Code thread without a resolved checkout has no repository to list, so the
 * panel says so rather than rendering an empty tree that looks like an empty
 * repository. Truncation and failure are stated in words next to an icon, never
 * signalled by colour alone.
 */
export function CodeFileExplorerPanel(props: CodeFileExplorerPanelProps) {
  const bound = props.threadId !== undefined && props.checkoutId !== undefined;
  const controller = useCodeFileListingController({
    enabled: bound,
    watch: true,
    ...(props.onFilesChanged === undefined ? {} : { onFilesChanged: props.onFilesChanged }),
    ...(props.client === undefined ? {} : { client: props.client }),
    ...(props.threadId === undefined ? {} : { threadId: props.threadId }),
    ...(props.checkoutId === undefined ? {} : { checkoutId: props.checkoutId }),
    ...(props.directory === undefined ? {} : { directory: props.directory }),
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });

  if (!bound) {
    return (
      <p className="code-file-explorer__status" role="status">
        <FolderTree aria-hidden="true" size={16} strokeWidth={1.8} />
        This Code thread is not bound to a checkout, so there are no repository files to list.
      </p>
    );
  }

  if (controller.status === "error") {
    // The one sentence, and one way back. Rendering the tree as well put a
    // live filter field and "No files match" beneath an explanation that
    // there are no files to match.
    return (
      <div className="code-file-explorer-panel">
        <p className="code-file-explorer__error" role="alert">
          {controller.errorMessage ?? "Repository files are unavailable."}
        </p>
        <div className="code-file-explorer-panel__recovery">
          <OctantButton
            onClick={() => void controller.refresh()}
            size="sm"
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Try again</span>
          </OctantButton>
        </div>
      </div>
    );
  }

  return (
    <div className="code-file-explorer-panel">
      <CodeFileExplorer
        entries={controller.entries}
        loading={controller.status === "loading"}
        onOpenFile={props.onOpenFile}
        onRefresh={() => void controller.refresh()}
        refreshing={controller.status === "loading"}
        truncated={controller.truncated}
        {...(props.selectedPath === undefined ? {} : { selectedPath: props.selectedPath })}
      />
    </div>
  );
}
