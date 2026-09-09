import { ShellState } from "../shell/ShellState";
export function unavailable(title: string, message: string) {
  return <ShellState message={message} state="neutral" title={`${title} is unavailable`} />;
}
export function loading(title: string) {
  return <ShellState state="loading" title={`Loading ${title}`} />;
}
