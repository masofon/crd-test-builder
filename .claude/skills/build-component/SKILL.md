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
