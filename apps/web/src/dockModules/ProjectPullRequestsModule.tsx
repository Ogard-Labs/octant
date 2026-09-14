import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { CodeProjectPullRequests } from "../code/CodeProjectPullRequests";
import { unavailable } from "./moduleState";

type Props = Pick<
  ThreadUtilityDockContentProps,
  "codeClient" | "onSelectProjectPullRequest" | "selectedProjectPullRequestKey" | "subject"
>;

/**
 * The active Code thread's Project as a list of its open pull requests. The
 * list is the same component the Pull requests page renders; the dock passes
 * the Project scope and lets a row open the existing Review tool in this dock.
 */
export default function ProjectPullRequestsModule(props: Props) {
  if (props.subject.mode !== "code") {
    return unavailable("Pull requests", "Pull requests open from a Code thread.");
  }
  if (props.subject.projectId === undefined) {
    return unavailable(
      "Pull requests",
      "This thread has no Project whose pull requests could be listed.",
    );
  }
  const codeClient = props.codeClient;
  if (codeClient === undefined) {
    return unavailable("Pull requests", "The Code connection is unavailable in this window.");
  }
  return (
    <CodeProjectPullRequests
      load={(query) => codeClient.queryProjectPullRequests(query)}
      presentation="dock"
      projectId={props.subject.projectId}
      refresh={(command) => codeClient.refreshProjectPullRequests(command)}
      {...(props.onSelectProjectPullRequest === undefined
        ? {}
        : { onSelectRow: props.onSelectProjectPullRequest })}
      {...(props.selectedProjectPullRequestKey === undefined
        ? {}
        : { selectedRowKey: props.selectedProjectPullRequestKey })}
    />
  );
}
