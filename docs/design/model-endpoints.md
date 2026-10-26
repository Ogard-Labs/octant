# Providers and model endpoints

This is the current specification for the Settings pages that list bundled
provider drivers and the model endpoints Octant calls itself.
[DESIGN.md](../../DESIGN.md#shell-and-layout) owns the Settings kit these pages
are built from and the provider card on Providers & Models;
[architecture](../architecture.md#providers) owns provider authority and
credential boundaries. Update this specification with an approved change,
following the [design workflow](README.md#changing-the-design).

## Provider catalog

Provider catalog, the section of Providers & Models under the providers this
host has, lists every
bundled provider driver in the Model endpoints row style. Agent runtimes and
model endpoints are two sections. A row is one link named with its state
("Codex CLI, off. Open setup") and shows the mark, the name, "Agent runtime ·
Bundled" or "Model endpoint · Bundled", and the state in words beside the same
dot shapes. The states are Ready, Sign in to use, Partly working, Checking…,
Not checked yet, Found, not added, Not looked for yet, Not on this host, Not
added, Off, Can't start, Version not supported, and Not available. A one-line
introduction says each driver is already installed and trusted, followed by a
summary ("21 drivers · 3 ready · 1 need you"). Opening a row replaces the page
with that driver's setup sub-page: Back and Escape as on an
endpoint's page, and an h1 with the driver's name. It leads with Set up, a
numbered list of steps (Find it on this host, for runtimes only; Add it to
Octant or Add the endpoint; Turn it on; Sign in; Check the connection). Done
steps carry a check. The current step carries one sentence, one action, and a
polite live region where a refusal shows the host's reason with Try again.
Next comes the runtime's own Providers & Models card (an endpoint links to its
Model endpoints page instead). Then come State (Available, Enabled, Signed in,
and Ready, each in words with its dot), What it can do (Chat, Work, Code, and
Agent loop in plain sentences, which also say whether Octant's sandbox or the runtime's own confines a runtime, as the confinement matrix in the architecture records it), and Package (Bundled with Octant, installed,
trusted and by whom it was reviewed, and the driver version). It offers no
install or trust action, because a bundled driver needs neither. Opening the
page or a setup runs nothing; at phone width a fact's value moves under its
name.

### A runtime whose saved binary is gone

A runtime card whose saved binary is missing or reported incompatible, while the
latest scan found the same driver at another path, offers one outlined action in
the card's details: "Use the one found at ~/.local/bin/claude (2.1.306)". The
card is missing when the scan searched where the saved binary should be and did
not find it, or when its last check could not start it. A runtime that is off
and that the scan did not find counts too, wherever its binary was saved: nothing
checks a runtime that is off, and the host refuses to turn it on while its
binary is gone, so without the offer such a card had no way out (a Claude Code
saved under an npm prefix that a native install had replaced). A saved binary
that starts and answers is never second-guessed, and a failed or cancelled scan
offers nothing. The offer names the launcher path the scan examined, not the
versioned file it resolves to, so it survives the runtime's own updates; of
several candidates it takes a compatible one with the highest version, and a
candidate the scan itself found incompatible or unavailable is never offered.
The details open when an offer first appears. Nothing switches by itself and
the offer never turns the runtime on.

Clicking the offer goes through the same host path as Locate binary, without
the file picker: the `locate-binary` command names a scanned path instead of a
picker receipt. The host accepts the path only when it is a candidate of the
same driver kind from its own latest scan, then checks it as it checks a picked
file (executable regular file, version probe under the same confinement) and
only then changes the card's binary path, leaving its other settings alone. An
enabled runtime is checked again right away. The answer is the same quiet line
(the version the host read) or a warning box with the host's reason. Because it
needs no picker, the action is also available in a browser.

### Claude API-key profiles on a headless host

A browser can create a named Claude API-key profile without a credential.
The key input remains disabled, with guidance to run
`octant provider key set "Profile name"` on the Linux host, then check the
connection. For a macOS host, the guidance directs the person to open the
profile in Octant desktop to add its key. This guidance remains in the created
profile’s Setup section, including after returning to Settings. Creation stores only the configuration and uses the existing
per-instance account-directory allocation. Desktop creation still requires
a key and saves it through native IPC. A browser-supplied secret is refused
before profile creation; host-local credential authority is unchanged.

## Octant Harness model endpoints

Octant Harness lists its model endpoints differently: as rows in one list, never two-up cards. A row is a single link named with its state ("Team gateway, not working, open details") and holds the source mark (the bundled mark keyed by the endpoint's sign-in, a monogram otherwise), the name, a sub-line (who is signed in, or the host and "API key" or "No key"), the state in words beside a dot whose shape carries it (filled for ready, a ring when it needs you, a dashed ring for off, a muted ring for not checked, a turning ring for checking that is a static dotted ring under reduced motion, and a diamond for failed), and the model count ("12 of 63 shown"). The states are Ready, Sign in to use, Sign in again, Signed out, Checking…, Can't connect, Key refused, Key needed, No access, Sign-in doesn't match, Not working, No models yet, Not checked yet, and Off. One that needs you adds one plain sentence and exactly one fix button under the link (Sign in, Sign in again, Try again, Replace key, Add key, Edit address, Add model IDs, Check now), announced through a polite live region on that row; a failed check never raises a page-level banner. The enable switch is the detail page's Use switch, and an endpoint that is off says "Off · kept, not offered" on its row.

### Endpoint detail

Opening a row replaces the page with the endpoint's detail sub-page (a Back control and Escape), whose h1 is the endpoint's name; Back returns focus to the row. The sub-page leads with the state, Check now, and Use, then the one fix, then Sign-in or API key, Models (search, a Shown / Hidden / All filter, a switch per model, and the plain tags "Reads images" and "Chat only · Verify tools"), Where your data goes (two labelled checkboxes the person sets, with per-model overrides in a disclosure), Name and address, Diagnostics (a disclosure that opens by itself only while the endpoint is failing, holding the address, protocol, authentication, last check with the host's precise answer, tool use, and capabilities), and Remove last, confirmed in a dialog that starts on Keep and names the model roles that lose a model. Precise terms (protocol names, bearer, capability names) appear only in Diagnostics.

### Subscription sign-in lifecycle

The sign-in section shows Checking sign-in until the host answers. Opening the
browser, waiting for consent, checking completion, signed in, cancelled, and
failed states are explicit and announced. A pending attempt offers the sign-in
page link and I've finished in the browser. Opening Settings never starts a new
sign-in or acknowledges terms. Returning to Settings resumes the originating
window's pending host attempt; repeated Begin requests reuse it. Attempts expire
with the provider deadline and do not survive a host restart. Each host request
times out after 15 seconds so a stalled connection cannot lock the completion
check; retrying keeps the same host attempt.

Signed-in account details keep Sign out visible with a description of its scope.
Octant asks for provider revocation when supported, then removes the local grant.
If revocation fails, it keeps the grant and offers an explicit local-only action.
Neither action promises removal of every provider account connection.

### Organization sign-in (Azure AI Foundry)

An Azure AI Foundry endpoint signs in with an API key or with the
organization's Microsoft Entra ID account
([Enterprise provider identity](enterprise-provider-identity.md) owns the
authority and binding rules). Add endpoint's Connect step for Azure AI Foundry
has a **Sign in with** choice (API key, or Organization account (Microsoft
Entra ID)). The organization account replaces the key field with Directory
(tenant) ID and Application (client) ID; both must be GUIDs, are saved
lowercased, and a domain name or `common` is refused with a sentence naming
what to paste. The endpoint is added with no key and reads Sign in to use; the
sign-in starts from its detail page, never from Add endpoint.

The detail page's Sign-in section is the same sign-in panel subscription
sign-ins use, with the button "Sign in with your organization", the consent
line naming what the sign-in does, "Signed in as" the account the directory
named, and a Sign out line that says it removes this computer's sign-in only and
does not end the organization session (sign-out answers Signed out on this
computer). Name and address keeps the endpoint's sign-in method: its
Authentication select (API key or Organization account) and the tenant and
client fields, and a note that switching methods removes what was stored for
the other. Diagnostics adds "Signed in for", the tenant, client, and origin the
last check bound to.

Row states read the host's reason: Sign in to use (no sign-in), Sign in again
with "Your organization asks you to sign in again in person…" (multi-factor or
a consent prompt; the sign-in is kept), Signed out (the sign-in ended), No
access (signed in without a role on the resource; no fix, a sentence naming
the role to ask for), and Sign-in doesn't match (the sign-in is for another
tenant, client, or address; Sign in again). None offers a key.

Octant Harness uses the existing `icons.svg#aperture` brand mark in provider lists
and model pickers. The mark inherits the theme's text color; the surrounding
control supplies its accessible name.

### Additional CLI accounts

Every Claude and Codex provider card offers Add account in its details, beside
Check connection. It opens the same manual form that Add provider manually
opens, expanded, with that driver chosen, the card's binary path filled in, and
a suggested name ("<card name> (2)", the next free number) focused for editing.
It adds no route and no authority: the host still assigns the account directory
and the form shows the sign-in guidance for an additional account. A created
account closes the form again, so the suggested name is not offered twice.
Cards for other drivers, and the single runtime card on a provider's own
page, have no Add account.

The manual Claude and Codex account forms give the account directory, accent
and sign-in guidance full-width setting rows. The compact provider/name/binary
fields may share columns; account rows must not become cells in that row.
When the Settings pane is narrow, controls stack below their labels and help,
keeping every input and the submit action reachable without horizontal clipping.

### Add endpoint

Add endpoint opens a dialog: the sign-ins first, then the presets, then a guided flow with a numbered strip of steps. A preset is a named service added with a pasted key (OpenCode Go, OpenCode Zen, Mistral, Requesty): its row sits in the same list as the sign-ins with a one-line description and Add with key, which opens Connect with the name, address and protocol filled in and the key hint naming the page where the key is made, as a link; the address stays editable, and the result is an ordinary endpoint of its kind. On the first-run page the same row opens the dialog on Connect. Kind is four cards (Azure AI Foundry, OpenAI-compatible, Anthropic-compatible, Local (Ollama)). Connect asks for a name, the address, and the key, each with a one-line hint, and no control is greyed out without a sentence saying why; protocol, how the key is sent, and "It takes no key" sit under Advanced, and an Azure address entered as OpenAI-compatible offers Switch to Azure AI Foundry. Azure also names at least one deployment, as chips, because the host cannot add it without one. Check and add adds the endpoint and shows its row state in the dialog, with its fix; from then on the endpoint exists, and closing the dialog keeps it. Models lists a short catalogue whole and chosen; a long one is searched, lists at most eight matches with a count of the rest, starts with nothing chosen, and has an Add by ID row; models left unchosen are hidden from the model picker. Azure edits its deployment chips; Local lists the models installed in Ollama, with no Add by ID. Verify tools checks each chosen model, one request at a time, after a button that says how many requests it sends; each model reads Checking…, Verified, or "Chat only" with the reason and Retry, and a failed check never stops the endpoint being added. Ollama models are checked the same way on this computer: the button says the requests run locally rather than that the service may bill, and a model Ollama says takes no tools reads Chat only without a generating request, with that reason. Ollama stays a loopback-only endpoint; a cloud, LAN, or tunnelled Ollama address is refused. When the endpoint lists a voice model (a preset's known transcription or speech model, or an id that reads as one), the last step and the endpoint's Voice section (after Models) say so in one line and offer Use for Transcription, which makes that model Voice's choice at once and then reads "Transcription uses <model> on <endpoint>"; a speech model is named with what it still needs, a voice from the provider, and Open Voice settings. Agents is optional: only verified models can be offered to helper agents or given an Octant Harness role (a Chat only model is listed with its checkbox off and a sentence saying why; role choices list verified models only, and Reading images only those that read images). A chosen role makes the model its first choice and keeps what it had as backups, saved with the roles' version; a stale version reloads the roles and asks again. In a browser, a kind that needs a key is added without one and reads Needs key, sending the person to the desktop app; Local works fully. "Chat only · Verify tools" is the one label for an unverified model on the endpoint row (when no shown model is verified), the endpoint's Models, the model pickers, and Add endpoint. Targets are 44px tall at phone width.

## Endpoint address and stored key

A model endpoint's API key belongs to the address it was entered for, so the
host deletes it when the saved address changes. The address field says so
while it differs from the saved one, in calm guidance text beneath the field
that is also the field's accessible description: saving removes the stored
key and it must be entered again. A spelling that normalises to the saved
address (such as a missing trailing slash) shows nothing. Until a check runs,
a keyed endpoint whose host credential store holds no key reads Needs key with
Add key on its row, in the same state a refused or missing key uses.

## Verification

- Provider catalog: `apps/web/src/providers/catalog/ProviderCatalogView.test.tsx`.
- Add endpoint: `apps/web/src/settings/harness/AddEndpointFlow.test.tsx`.
- Render changed pages at desktop and phone width, including each refusal line
  and the keyboard path back from a detail sub-page.
