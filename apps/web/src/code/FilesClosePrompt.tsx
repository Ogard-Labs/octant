import { useSyncExternalStore } from "react";
import { filesClosePromptSnapshot, subscribeFilesClosePrompt } from "./filesCloseGuard";
import { UnsavedFileDialog } from "./UnsavedFileDialog";

/**
 * The close question the files-close registry is asking, mounted at the
 * application root so it stands whether the dock that owned the file is
 * hidden, inert, or already gone.
 */
export function FilesClosePrompt() {
  const prompt = useSyncExternalStore(subscribeFilesClosePrompt, filesClosePromptSnapshot);
  if (prompt === undefined) return null;
  return (
    <UnsavedFileDialog
      {...(prompt.failure === undefined ? {} : { failure: prompt.failure })}
      name={prompt.name}
      onChoose={prompt.answer}
    />
  );
}
