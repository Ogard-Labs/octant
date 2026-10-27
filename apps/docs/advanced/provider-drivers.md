---
description: Build, test, package, install, trust, and enable a provider driver that does not ship with Octant, starting from the example loopback driver.
---

# Build a Provider Driver

An **outside provider driver** lets Octant use a model service that has no
driver bundled with Octant. You write it as a small JavaScript package; a
person reviews it, installs it, trusts it, and switches it on, each as a
separate step, and then adds a provider from it under
[Providers and models](/advanced/providers#outside-drivers).

A driver only translates. Octant sends it a conversation, and the driver
turns it into the requests its model service understands and the service's
answers back into text and tool calls. Octant does everything else: the agent
loop, tools and approvals, retries, the transcript, and checking whether a
model can use Octant's tools (**Verify tools**). Nothing a driver claims raises
what Octant lets it do.

## What a driver can reach

A driver runs in its own process, one per provider, confined by the operating
system:

- **No network.** The driver asks Octant to make each request for it, and
  Octant sends it only to the address the person entered when they added the
  provider (HTTPS, or HTTP on this computer). Redirects are not followed.
- **No key.** If the service needs a key, Octant adds it to each request
  itself, in the header the person chose. The driver never sees it.
- **No files** beyond its own package, and a temporary folder removed when it
  stops. It cannot start programs.
- **Its text goes nowhere.** Failures reach people in Octant's own words, and
  what the driver writes to stderr is kept bounded and never shown.

Only a Mac runs outside drivers. Linux and Windows hosts cannot confine one,
so they never start it.

## Start from the example

The Octant repository holds an example driver package at
`packages/provider-sdk/examples/loopback-chat-driver`. It speaks the
OpenAI-compatible chat completions protocol of a model server running on
your Mac, such as llama.cpp's `llama-server`, LM Studio, vLLM, or Ollama's
`/v1` address:

```text
loopback-chat-driver/
├── octant-provider-driver.json   the driver's description
├── driver.mjs                    the entry Octant runs
└── lib/
    ├── loopback-chat.mjs         the translation
    └── outside-driver-serve.mjs  the serve helper, copied from the provider SDK
```

To try it, start your model server, then add the folder as described in
[Install, trust, and switch it on](#install-trust-and-switch-it-on). For the
provider, enter the server's address (for example `http://127.0.0.1:8080/v1`),
choose **No key (this computer only)**, and list the model IDs the server
serves.

## Package rules

A driver package is a folder whose root holds `octant-provider-driver.json`:

```json
{
  "driverKind": "outside-harness-endpoint",
  "protocolVersions": ["harness-endpoint/1"],
  "manifest": {
    "manifestVersion": 1,
    "slug": "loopback-chat-example",
    "displayName": "Loopback chat (example)",
    "version": "0.1.0",
    "provenance": { "publisher": "Example", "canonicalUrl": "https://example.com/driver" },
    "license": { "kind": "spdx", "identifier": "MIT" },
    "compatibility": {
      "platforms": ["macos"],
      "modes": ["chat", "work", "code"],
      "providerFamilies": []
    },
    "declaredCapabilities": [],
    "primaryComponentId": "driver",
    "components": [
      {
        "id": "driver",
        "kind": "provider-driver",
        "displayName": "Loopback chat (example)",
        "declaredCapabilities": [],
        "entryPoint": "driver.mjs"
      }
    ]
  }
}
```

Octant refuses a package, before installing it, when:

- its entry is not a `.mjs` file inside the package. The entry is plain
  JavaScript in an ES module; Octant runs it on its own runtime, which is
  Electron's Node in the app, and `.mjs` is the one suffix every runtime loads
  that way. TypeScript must be compiled to JavaScript first;
- it holds any file with an execute permission, native code (a `.node`,
  `.dylib`, `.so`, `.dll`, or `.exe`, or a compiled program under any name),
  or an install script (a `binding.gyp`, or an install step in any
  `package.json`). Octant runs no install step, so ship every module your
  driver imports inside the package;
- it declares capabilities or contributions, holds more than the one
  `provider-driver` component, or uses a bundled driver's name as its slug;
- it speaks no protocol version Octant speaks (`harness-endpoint/1` today);
- the description states the package's own identity, source, digest, or
  review (`extensionId`, `packageId`, `source`, `digest`, `reviewed`, or
  `reviewedAt`). Octant sets those itself.

## Write the driver

Octant and the driver exchange one JSON-RPC 2.0 message per line on the
driver's stdin and stdout. The serve helper speaks that protocol for you: copy
`packages/provider-sdk/src/outsideDriverServe.mjs` from the Octant repository
into your package (it is not published to npm yet) and import it from your
entry:

```js
import { OutsideDriverFailure, serveOutsideDriver } from "./lib/outside-driver-serve.mjs";

let baseUrl = "";

serveOutsideDriver({
  // The address and model IDs the person entered when they added the provider.
  initialize(configuration) {
    baseUrl = configuration.baseUrl;
  },
  // The models the service can serve; Octant offers only the ones the person listed.
  async probe(host) {
    const response = await host.http({ url: new URL("models", baseUrl).href, method: "GET" });
    if (!response.ok) throw new OutsideDriverFailure("unavailable");
    const body = await response.json();
    return { models: body.data.map((model) => ({ id: model.id })) };
  },
  // One model request: stream what arrives, then settle with the whole answer.
  async send({ request }, turn) {
    const response = await turn.host.http({
      url: new URL("chat", baseUrl).href,
      method: "POST",
      headers: [["content-type", "application/json"]],
      // Your translation of Octant's request into the service's own.
      body: JSON.stringify(serviceRequest(request)),
    });
    if (response.status === 429) throw new OutsideDriverFailure("rate-limited");
    let text = "";
    for await (const piece of response.chunks()) {
      if (turn.signal.aborted) throw new OutsideDriverFailure("interrupted");
      // A piece can end anywhere, even mid-line: a service that streams lines
      // or events needs them buffered and parsed only once whole.
      text += piece;
      turn.emit({ kind: "text-delta", text: piece });
    }
    return { text, toolCalls: [] };
  },
});
```

What Octant holds a driver to:

- **Write only what the protocol names.** Octant reads every message strictly
  and stops the driver at the first one it cannot read: a field the protocol
  does not have, a model name longer than 256 characters, more than 256
  models, or a line that is not a protocol message. Nothing but protocol
  messages may go to stdout; the serve helper sends `console` output to
  stderr for you.
- **Fail with a category.** Throw `OutsideDriverFailure` with one of
  `unavailable`, `unauthenticated`, `unauthorized`, `rate-limited`,
  `unsupported`, `incompatible`, `invalid-configuration`, `protocol`,
  `interrupted`, or `provider-failed`. Add `retryAfterMs` to a rate limit,
  and `contextOverflow: { contextWindowTokens }` when the request outgrew the
  model's window, so Octant can shorten the next one. Any other error becomes
  `provider-failed`; your message text is never shown.
- **Ask for the key where the service reads it.** A request that needs the key
  names the header with `auth`, for example
  `auth: { header: "authorization", scheme: "Bearer" }`, which matches
  **Bearer token** in the provider's setup, or `auth: { header: "x-api-key" }`
  for **A header of its own**. Tell people which one your driver uses: Octant
  refuses a request that asks for the key anywhere else, or for a provider
  added with **No key**. A driver never sets `authorization`, `cookie`,
  `host`, or `proxy-authorization` itself.
- **Leave retries, tools, and images to Octant.** Octant retries a failed
  request itself, decides which models may use its tools, and does not send a
  driver the files a person attaches.

## Test it in your CI

The conformance kit plays Octant's part against your driver's process, using a
fake model service you write, and fails the run at the first message Octant
would refuse. It lives in the provider SDK in the Octant repository
(`@octant/provider-sdk/outside-driver-conformance`):

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { runOutsideDriverConformance } from "@octant/provider-sdk/outside-driver-conformance";

const child = spawn("node", ["driver.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });

await runOutsideDriverConformance({
  channel: {
    write: (line) => child.stdin.write(`${line}\n`),
    onLine: (listener) => lines.on("line", listener),
  },
  configuration: { baseUrl: "http://127.0.0.1:8080/v1/", modelIds: ["local-model"] },
  // How a provider for your service sends its key; leave it out for none.
  key: undefined,
  // Your fake model service; the kit makes the driver's requests through it.
  fetch: fakeModelService,
  request: {
    sessionId: "00000000-0000-4000-8000-000000000001",
    modelId: "local-model",
    history: [{ role: "user", text: "Say hello" }],
    tools: [],
  },
});
```

The kit checks the handshake, the probe, a streamed answer, that the driver
keeps answering after a cancel and after a session ends, that its failures
carry a category, and that every request it asks for stays on the configured
address and asks for the key only where the provider sends it. It hands the
driver response bodies in small pieces, as Octant does. Passing the kit
installs, trusts, and switches on nothing: Octant checks every message again
when it runs the driver, and runs **Verify tools** itself.

## Install, trust, and switch it on

On a Mac, in the Octant desktop app:

1. **Plugins → Marketplace → Import local Agent Plugin…**, and pick the
   driver's folder.
2. **Review before installing** shows the package's name, version, digest,
   and that it holds a provider driver. **Confirm install** stores it held:
   untrusted, switched off, and with no process.
3. Under **Installed**, **Trust source**. Trust holds for the exact contents
   you reviewed.
4. Switch the plugin on, and its driver component.
5. In **Settings → Providers & Models → Provider catalog**, the driver is
   listed under **Outside drivers**. Its setup adds a provider: a name, the
   service's address, how the key is sent, the key, and the model IDs to
   offer. The provider is added off.
6. Turn it on and use **Check connection**, which starts the driver for the
   first time. Then use **Verify tools** on a model before relying on it for
   Octant's tools.

These steps are available only in a window on the Mac itself; a paired device,
an agent, or a mention cannot install, trust, switch on, or add one.

When you change the driver, import the folder again and install the new
version. It arrives held and untrusted, and providers added from the earlier
version stay blocked, with their history and key, until you remove them and
add them again from the version you trust.

## Signing

A driver added from a local folder is unsigned developer input, and its review
says so; trust is bound to the exact contents you reviewed. Drivers from a
marketplace source will carry a publisher signature whose key is pinned when
you first trust it, so a later version signed by another key is refused until
you trust it as a new publisher. Only local folders are accepted today.
