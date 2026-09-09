import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { DockCanvasTool } from "../shell/DockCanvasTool";

type Props = Pick<ThreadUtilityDockContentProps, "canvasClient" | "subject" | "writtenCanvasId">;

export default function CanvasModule(props: Props) {
  return (
    <DockCanvasTool
      {...(props.canvasClient === undefined ? {} : { client: props.canvasClient })}
      mode={props.subject.mode}
      {...(props.subject.projectId === undefined ? {} : { projectId: props.subject.projectId })}
      {...(props.writtenCanvasId === undefined ? {} : { preferredCanvasId: props.writtenCanvasId })}
      threadId={props.subject.threadId}
    />
  );
}
