import { OctantEmpty } from "../ui/base/OctantEmpty";
import { Compass } from "../ui/icons";

/** A tool that cannot open: the panes' one empty state (mark, line, muted line), as Agents draws it. */
export function unavailable(title: string, message: string) {
  return (
    <OctantEmpty
      detail={message}
      icon={<Compass size={16} />}
      layout="line"
      title={`${title} is unavailable`}
    />
  );
}
export function loading(title: string) {
  return <OctantEmpty state="loading" title={`Loading ${title}`} />;
}
