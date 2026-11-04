import type { AutomationRun } from "@octant/contracts";
import {
  frameExternalContentForModel,
  type FramedExternalContent,
} from "../context/externalContentFraming";

export interface AutomationFileContext {
  readonly referenceId: string;
  readonly content: FramedExternalContent;
}

/** Immutable bounded filename data; the person's instruction remains the fixed task. */
export function automationFileContext(run: AutomationRun): AutomationFileContext | undefined {
  if (
    run.occurrence.kind !== "file-arrival" ||
    run.definitionSnapshot.trigger.kind !== "file-arrival"
  )
    return undefined;
  const directory = run.definitionSnapshot.trigger.directory;
  const all = run.occurrence.source.files;
  const observedAt = run.occurrence.source.checkpoint.observedAt;
  const files: string[] = [];
  const body = () =>
    JSON.stringify({
      directory,
      pathsRelativeTo: "input-directory",
      files,
      omittedFiles: all.length - files.length,
      observedAt,
    });
  for (const path of all) {
    files.push(path);
    if (body().length > 4_096) {
      files.pop();
      break;
    }
  }
  return {
    referenceId: `automation-file-batch:${run.occurrenceKey}`,
    content: frameExternalContentForModel({
      origin: "external-content",
      sourceLabel: "file-arrival-routine",
      body: body(),
      section: "workspace-context",
    }),
  };
}

export function automationDispatchPromptText(run: AutomationRun): string {
  const context = automationFileContext(run);
  return context === undefined
    ? run.definitionSnapshot.taskPrompt
    : `${run.definitionSnapshot.taskPrompt}\n\n${context.content.text}`;
}
