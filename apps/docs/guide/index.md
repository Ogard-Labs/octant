---
description: Start here for the Octant guide. Learn to install, configure, and work across Chat, Work, and Code.
---

# Guide

Welcome to the Octant guide. Use these pages to install the app, configure providers, and work across the three modes.

## Getting started

- [Installation](/guide/installation) — system requirements, source build, and packaging
- [First Run](/guide/first-run) — configure a provider, create a Project, start a thread

## Working with modes

- [Chat](/guide/chat) — conversations in virtual Projects with scoped memory
- [Work](/guide/work) — local knowledge work with a bound folder
- [Code](/guide/code) — repository engineering with Git authority

## Projects and context

- [Projects](/guide/projects) — create, manage, and organize Projects across modes
- [Shared Memory](/guide/memory) — persist decisions, facts, and context across threads
- [Promotions](/guide/promotions) — escalate Work work to a linked Code thread

## Concepts

- [Modes](/concepts/) — the Chat, Work, and Code mode boundaries

## Workspace shell

The window is mode-first: Chat, Work, and Code in the sidebar, a central
workspace, and an optional right dock. A workspace pane holds one surface —
the thread you are reading, a Project overview, a board, or a welcome — and
the sidebar is how you switch. Same-authority threads can be pinned or dropped
into split panes; the active pane is marked, and the right dock follows that
pane's thread and Project. Work and Code have server-derived thread boards;
Chat has no board.

An approved later interaction model is recorded in the architecture decision
records and is **not** what the app renders today for remaining dock
placement: Environment will be a compact header disclosure rather than a
persisted panel; context usage already lives on the composer meter; Project
memory will live in Project Overview; Navigator will open as a host-wide
popover from the profile control. Until that migration lands, the pages in
this guide describe the surfaces that are actually on screen.

## Current boundary

This documentation covers the unsigned Apple Silicon technical preview. It reflects
accurate current product behavior and does not claim that every workflow is finalized.
Capabilities that remain in progress are noted where relevant.
