import { watchDesktopParent } from "./desktopParentWatch";

// The shape of main.ts: watch the desktop's pipe while serving, and on SIGTERM
// finish shutting down. Whatever still holds the event loop open after that
// keeps the process alive, so this fixture holds nothing else.
const serving = setInterval(() => undefined, 1_000);
const stopWatching = watchDesktopParent({
  enabled: true,
  input: process.stdin,
  onDisconnect: () => process.exit(2),
});
process.once("SIGTERM", () => {
  clearInterval(serving);
  stopWatching();
});
console.log("watching");
