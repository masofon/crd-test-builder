---
name: import-variables
description: Refresh the design tokens from the project's Figma file.
---

# Import design variables

Runs this repo's committed extraction payloads against the project's Figma
file, writes what comes back beside the payloads — one export per pull,
`figma-variables.json` and `figma-styles.json` — and regenerates
`src/tokens.css` from them.

The generated CSS is what a candidate builds against and what a trial clones.
It is not an experimental variable: both arms of a trial get the same tokens,
unlike the CRD.

**Variables and styles are two separate pulls**, because Figma exposes them as
two separate Plugin API surfaces. They share the transport discipline below and
nothing else.

**Nothing between Figma and the CSS is a judgement call.** The payload
normalises colours to hex inside Figma, the merge verifies what came back
against a fingerprint Figma computed, and the generator is deterministic. The
agent's only job is to carry bytes from one side to the other and to stop
loudly when a check fails.

## Precondition

An authenticated Figma MCP connection.

## Inputs

The skill takes no arguments.

Figma file key: `Qayy6zy5OxSRT4cbvFqjXR`

## Workflow

1. **Load the mandatory `/figma-use` skill.** The Figma MCP server's own
   instructions make it a prerequisite before any `use_figma` call. Do not skip
   it.

2. **Read the variable payload from disk, unaltered.** Read
   `.claude/skills/import-variables/extract-figma-variables.js` with the
   `Read` tool.

3. **Pass those contents to `mcp__figma__use_figma` verbatim.** `use_figma`
   takes its `code` as an inline string with no path parameter, so the file
   contents become the `code` argument exactly as read — no edits, no
   reformatting, no paraphrasing, no "equivalent" payload authored inline. Pass
   the file key above, and include `figma-use` in `skillNames`.

   This rule is load-bearing, not a style preference. The committed script and
   the one that actually ran must be the same script, or the repo's record of
   how variables are extracted is fiction.

4. **Repeat the call until it reports `done: true`.** A tool result is truncated
   at roughly 20kB, so the payload returns as many variables as fit a byte
   budget and leaves a cursor in the file's shared plugin data. Call it again —
   the same file, unaltered, same arguments — and it resumes where it stopped.
   The compressed form below currently fits the whole set in one call, but the
   loop is not optional: the budget is on bytes, and the set grows.

   A chunk's variables come back compressed, one positional row each — see
   [the chunk format](#appendix-the-compressed-chunk-format) at the end of this
   file if you need the encoding. Nothing here needs decoding by hand: step 5's
   merge restores the objects and only then checks the fingerprint, so the guard
   still covers every value.

   **Write each chunk to its own file as it arrives**, verbatim, at
   `.import-variables-temp/chunk-<n>.json`. Transcribe rather than summarise:
   these values are the design system.

   Report `N` and say the Figma connection succeeded — any count coming back is
   a success.

5. **Merge the chunks into the export.** Run:

   ```sh
   mise x -- node ./.claude/skills/import-variables/merge-figma-pull.js \
     variables .import-variables-temp/chunk-*.json
   ```

   It decodes the rows back into variable objects, refuses anything that is not
   a complete, self-consistent run — chunks from different pulls, a gap or
   overlap in the cursor ranges, an unfinished run — and then verifies the
   merged result against the `fingerprint` Figma computed over every value. That
   check is the one that matters: the agent retypes each chunk by hand, and a
   count catches a variable that went missing but not a hex digit that came out
   wrong. On a mismatch it refuses to write, and the pull should be re-run
   rather than patched by hand.

   It writes `.claude/skills/import-variables/figma-variables.json`. Because
   that file holds exactly the shape the payload returns, a re-pull overwrites
   it cleanly with no hand-reshaping.

6. **Pull the styles.** Styles — paint, text and effect — are a separate Plugin
   API surface from variables, so they are a second pull rather than part of the
   one above.

   Read `.claude/skills/import-variables/extract-figma-styles.js` with the
   `Read` tool and pass its contents to `mcp__figma__use_figma` verbatim, under
   exactly the rule step 3 states: the committed script and the one that ran
   must be the same script. Same file key, `figma-use` in `skillNames`.

   This pull is **not chunked and not compressed** — all three style dumps
   together sit inside the result cap — so it returns everything in one call and
   there is no loop and no cursor. Write what comes back to
   `.import-variables-temp/styles.json`, verbatim, then merge it:

   ```sh
   mise x -- node ./.claude/skills/import-variables/merge-figma-pull.js \
     styles .import-variables-temp/styles.json
   ```

   Same script as step 5, under its other mode: one pull, one export. It writes
   `figma-styles.json` beside the variables export — all three style types in the
   one file, because they come back from the one call — but only after the count
   and the fingerprint Figma computed both agree with what it recomputes over the
   styles. On a mismatch it refuses to write, and the pull should be re-run
   rather than patched by hand.

   **What the styles hold that the variables cannot.** Every gradient stop and
   almost every text-style field is bound to a variable, and the export records
   each binding as the variable's **name** — reading the resolved value instead
   produces an export that looks complete and has silently lost every binding.
   What is genuinely only here is what Figma has no variable type for: gradient
   stop positions and `gradientTransform`, `textCase`, `textDecoration`,
   `paragraph*`, `listSpacing`, `leadingTrim`, and the `{unit, value}` wrapper
   that says PIXELS where the bound variable holds a bare float.

7. **Regenerate the CSS.** One generator over both exports:

   ```sh
   mise x -- node ./.claude/skills/import-variables/generate-tokens-css.js
   ```

   It writes `src/tokens.css` — a single `:root` block
   carrying the primitives, the semantic tokens as `var()` references to them,
   and the paint and effect styles as composite values, plus one class per text
   style. It prints a line per input export and a total, and the counts agreeing
   is the check:

   ```text
   src/tokens.css
     Primitives   186 variables in the export
     Semantic     348 variables in the export
     paint          9 styles in the export
     effect         6 styles in the export
     text          14 styles in the export
     emitted      549 custom properties and 14 classes (counts agree)
   ```

   The generated file is never hand-edited; the regeneration diff is the review
   surface.

8. **Delete the scratch files.** Both merges have written their exports and the
   CSS is regenerated, so the transcribed chunks have served their purpose:

   ```sh
   rm -rf .import-variables-temp
   ```

   Do this only after step 7 has succeeded — on any failure above, leave
   `.import-variables-temp` in place so the pull can be inspected.

9. **Commit the CSS.** `run-test.sh` clones this repo fresh from GitHub for
   every arm of a trial, so a `tokens.css` that is only on disk reaches no
   candidate. Report the diff and tell the human it needs committing and
   pushing; do not push it yourself.

## Failures

Surface them; never swallow them. If the Figma connection fails or the payload
throws inside Figma, report the actual error text to the session and stop. Do
not retry silently, do not substitute a guessed count, and do not paper over a
failure with a summary that reads like success.

`use_figma` is atomic — a failed script does not execute — so there is nothing
to clean up after an error.

The generator exiting non-zero on a Figma variable or style it has no rule for
is a deliberate stop, not an obstacle to work around — a FLOAT whose name says
nothing about being a length, a paint style that is not a single linear
gradient, a text style with a non-zero paragraph spacing. Do not hand-patch the
generator to make the pull land, and do not hand-edit `tokens.css` to fill the
gap: a new rule is code, and it belongs in the generator on its own commit.

Stop the run, report the variable or style and the rule that rejected it, and
tell the human. Once the rule has landed, re-run this skill from the top — every
step is idempotent, so the halted run leaves nothing to unwind.

## Appendix: the compressed chunk format

The format `extract-figma-variables.js` emits and `merge-figma-pull.js` decodes.
**Nothing in the workflow above needs it** — the merge restores the objects and
only then checks the fingerprint, so no chunk is ever decoded by hand. It is
written down for whatever wants to reason about the encoding.

Each call returns `{ "variableCount": N, "fingerprint": F, "from": i, "to": j,
"done": bool, "collections": [...] }`. A collection carries its `name`, `modes`,
`defaultMode`, `remote` flag and, under `rows`, the slice of its variables in
this chunk.

**The variables are compressed, one positional row each** — a schema-level
encoding that takes the pull from three chunks to one, so there is that much
less to retype. A row is:

```text
[prefixLength, nameSuffix, typeCode, ...values]
```

with the variable's `description` occupying the slot after the last value when
it has one. `typeCode` is `F`, `C`, `S` or `B` (`FLOAT`, `COLOR`, `STRING`,
`BOOLEAN`). The values run in the collection header's `modes` order, one per
mode, so a row never repeats a mode name; a colour is hex and an alias is a
one-element array holding the target's index into the pull's variable order
(`[42]`), which is what keeps it distinguishable from a number. The name is
front-coded: take `prefixLength` characters of the **previous row's** name and
append `nameSuffix`. That chain never resets — not across a collection
boundary, not across a chunk boundary — so a chunk cannot be decoded on its
own, and neither can an alias index be resolved from one chunk alone.
