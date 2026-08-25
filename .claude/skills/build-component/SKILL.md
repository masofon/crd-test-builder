---
name: build-component
description:
  Build one React component from a Figma component. Optionally takes a
  requirements file to build against.
arguments: [component-name, figma-url, requirements-path]
argument-hint: <component-name> <figma-url> [requirements-path]
---

Build the Figma component at `$figma-url` as a React component in this
project, under the name `$component-name`.

Two files for it already exist as placeholders. Replace both:

- `src/components/$component-name.tsx` — the component, default-exported.
- `src/components/$component-name.preview.tsx` — a component taking no
  props, default-exported, rendering a demo of every variant. The gallery
  in `src/main.tsx` already renders it.

Any styles it needs go beside them as `src/components/$component-name.css`
(or `.module.css`).

Do not modify `src/tokens.css` in any way.

Do not edit `src/main.tsx`. It is already written and already lists your
preview.

`src/components/` holds the other components in this project — some built,
some still placeholders. Read them if it helps you match the project's
conventions, but do not modify, rename or delete any file belonging to
another component.

If `$requirements-path` was given, read that file and treat it as the
component's requirements alongside the Figma reads. If it was not given,
work from the Figma reads alone.

If anything unexpected happens (e.g. you don't have access to something,
an error is thrown during your processes) stop and explain the error.

Do not give any output other than errors or unexpected outcomes. If
everything went well, say nothing. Do not give a summary.
