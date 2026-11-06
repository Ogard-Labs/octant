import type {
  AutomationRun,
  AutomationFileArrivalReceipt,
  AutomationIntegrationEventReceipt,
} from "@octant/contracts";
import {
  frameExternalContentForModel,
  type FramedExternalContent,
} from "../context/externalContentFraming";

export interface AutomationFileContext {
  readonly referenceId: string;
  readonly content: FramedExternalContent;
}

export function automationCodeInputDirectory(run: AutomationRun): string {
  return `octant-routine-inputs/${run.id}`;
}

export function automationRunFileSource(
  run: AutomationRun,
): AutomationFileArrivalReceipt | undefined {
  return run.occurrence.kind === "file-arrival"
    ? run.occurrence.source
    : run.occurrence.kind === "manual"
      ? run.occurrence.fileSource
      : undefined;
}

export function automationRunEventSource(
  run: AutomationRun,
): AutomationIntegrationEventReceipt | undefined {
  return run.occurrence.kind === "integration-event"
    ? run.occurrence.source
    : run.occurrence.kind === "manual"
      ? run.occurrence.eventSource
      : undefined;
}

/** Immutable bounded filename data; the person's instruction remains the fixed task. */
export function automationFileContext(run: AutomationRun): AutomationFileContext | undefined {
  const eventSource = automationRunEventSource(run);
  if (eventSource !== undefined)
    return {
      referenceId: `automation-event:${run.occurrenceKey}`,
      content: frameExternalContentForModel({
        origin: "external-content",
        sourceLabel: "routine-integration-event",
        body: JSON.stringify({
          source:
            run.definitionSnapshot.trigger.kind === "integration-event"
              ? run.definitionSnapshot.trigger.sourceLabel
              : "Integration event",
          event: eventSource.event,
          observedAt: eventSource.checkpoint.observedAt,
        }),
        section: "workspace-context",
      }),
    };
  const source = automationRunFileSource(run);
  if (source === undefined || run.definitionSnapshot.trigger.kind !== "file-arrival")
    return undefined;
  const directory =
    run.definitionSnapshot.mode === "code"
      ? automationCodeInputDirectory(run)
      : run.definitionSnapshot.trigger.directory;
  const all = source.files;
  const observedAt = source.checkpoint.observedAt;
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
