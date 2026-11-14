export function unavailable(title: string, message: string) {
  return <OctantEmpty message={message} state="neutral" title={`${title} is unavailable`} />;
}
export function loading(title: string) {
  return <OctantEmpty state="loading" title={`Loading ${title}`} />;
}import { OctantEmpty } from "../ui/base/OctantEmpty";

