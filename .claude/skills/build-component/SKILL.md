---
name: build-component
description:
  Build one React component from a Figma component. Optionally takes a
  requirements file to build against.
arguments: [figma-url, requirements-path]
argument-hint: <figma-url> [requirements-path]
---

Build the Figma component at `$figma-url` as a React component in this
project. Write it to `src/Component.tsx` and mount it in `src/main.tsx` as
the page's only component.

If `$requirements-path` was given, read that file and treat it as the
component's requirements alongside the Figma reads. If it was not given,
work from the Figma reads alone.

If anything unexpected happens (e.g. you don't have access to something,
an error is thrown during your processes) stop and explain the error.

Do not give any output other than errors or unexpected outcomes. If
everything went well, say nothing. Do not give a summary.
