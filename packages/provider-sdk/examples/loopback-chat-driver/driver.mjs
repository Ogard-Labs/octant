// The entry the host runs: it serves the example driver on stdin and stdout.
import { createLoopbackChatDriver } from "./lib/loopback-chat.mjs";
import { serveOutsideDriver } from "./lib/outside-driver-serve.mjs";

serveOutsideDriver(createLoopbackChatDriver());
