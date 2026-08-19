---
description: Work mode binds one OS-confined folder for local knowledge work with documents, artifacts, research, and citations.
---

# Work

Work is local knowledge work for documents, presentations, spreadsheets, reports, PDFs, images, and artifacts. Each Work Project binds exactly one OS-confined project root selected through the native directory picker.

## Work Projects

Create a Work Project from the sidebar:

1. Select **Work** as the mode.
2. Use the native picker to choose a directory.
3. Name the Project.

The selected directory becomes the confined root. Work threads cannot access paths outside this root. The renderer receives an opaque receipt rather than the raw path.

## Authority and confinement

Work threads operate within the bound Project root. Filesystem operations, artifact mutations, and tool access are confined to that directory. The server enforces confinement; renderer focus cannot extend authority.

Capability-aware workspace surfaces available in Work include:

- Confined Files/Explorer
- Artifact Review and preview surfaces
- Browser tabs (host-owned, policy-gated)
- Research with citations and provenance
- Scoped memory and child agents

Work does not expose Code Git/terminal authority. When Work work becomes software engineering, use a [promotion](/guide/promotions) to start a linked Code thread with explicit user approval.

## Research workflow

Work supports a research workflow with citations and provenance. Research threads can produce briefs, sources, evidence, claims, and reports. Citations link back to verified sources within the confined root or approved external references.

## Artifacts and previews

Work threads can create, edit, and preview artifacts within the bound root. Preview surfaces are authenticated and cancelable. Split-view previews render through the shared renderer with server-authoritative policy.

## Attaching images

Paste or attach a PNG, JPEG, WebP, or GIF in the Work composer to send it with the first provider turn. The image uploads to the host after the thread is created, and the turn names only the identifier the host answered with, so the provider receives bytes the host itself accepted.

A turn carries at most eight images, each up to 10 MB, alongside a written message. If the selected model does not read images, the composer says so at the paste instead of taking the file. The host checks the thread's own model again at send, so a turn never reaches a model with its pictures quietly dropped. Removing a chip before sending keeps that image off the turn.

## Next steps

- [Promotions](/guide/promotions) for escalating Work work to a Code thread
- [Projects](/guide/projects) for managing Work Projects
- [Code](/guide/code) for repository engineering
