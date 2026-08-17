// Merge a Figma pull into the committed exports.
//
// Run it as:
//
//   mise x -- node ./.claude/skills/import-variables/merge-figma-pull.js \
//     variables .local/temp/chunk-*.json
//   mise x -- node ./.claude/skills/import-variables/merge-figma-pull.js \
//     styles .local/temp/styles.json
//
// Two pulls, one script, because they differ only in shape: both come back from
// a `use_figma` call the agent has to retype, and both are checked the same way.
//
// The variable pull is chunked, because a tool result is truncated at roughly
// 20kB and the variable set is bigger than that (see `extract-figma-variables.js`
// beside this file). The style pull is not — all three style dumps together sit
// inside the cap (see `extract-figma-styles.js`) — so it arrives whole and there
// is nothing to stitch.
//
// What both need is the transcription check. The agent cannot pipe a tool result
// to disk — it retypes it — so every pull carries a fingerprint Figma computed
// over everything it returned. Recomputing that hash here turns a mistyped hex
// digit from a silent wrong value into a loud failure. A count alone would not: a
// count catches something that vanished, not something whose value came out
// wrong. Nothing is written until the hash agrees.
//
// This is JavaScript for the same reason the fingerprint is reproducible at all:
// the hash and the JSON shape are both defined by the extraction payloads running
// inside Figma. Recomputing them in the language that defined them removes a
// translation layer — `JSON.stringify` and `Math.imul` here are the same
// `JSON.stringify` and `Math.imul` there.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../../..");

const VARIABLES_PATH = path.join(__dirname, "figma-variables.json");
const STYLES_PATH = path.join(__dirname, "figma-styles.json");

const PROGRAM = "merge-figma-pull";

const TYPE_NAME = { F: "FLOAT", C: "COLOR", S: "STRING", B: "BOOLEAN" };

// The style guard below spans every style type in this order.
const STYLE_TYPES = ["paint", "text", "effect"];

function fail(message) {
  throw new Error(message);
}

// --- shared ----------------------------------------------------------------

// Reproduce the fingerprint an extraction payload reports over a pull: the
// payload's `h = Math.imul(h, 31) + charCode` hash over the joined source,
// rendered as `<count>:<base36>`. Each caller below builds its own `source`,
// because what a line holds differs from pull to pull.
//
// A payload runs in a Figma plugin sandbox with no module loader, so it carries
// its own copy of this loop rather than importing it.
function fingerprintOfSource(source, count) {
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (Math.imul(hash, 31) + source.charCodeAt(i)) | 0;
  }
  return `${count}:${(hash >>> 0).toString(36)}`;
}

// Turn the CLI's file arguments into parsed JSON, refusing an empty argument
// list, a path that is not a file, and a file that is not valid JSON. Messages
// are thrown already prefixed, leaving the caller's `catch` to print and exit.
function readJsonFiles(files) {
  if (files.length === 0) throw new Error(`${PROGRAM}: no input files given`);

  return files.map((file) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`${PROGRAM}: ${file}: no such file`);
    }
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`${PROGRAM}: ${file}: not valid JSON — ${error.message}`);
    }
  });
}

// --- variables --------------------------------------------------------------

// Undo the payload's front-coded name chain (see `extract-figma-variables.js`):
// a row's name is its first element's worth of leading characters from the
// previous name, plus its second element. The chain spans the whole run — it
// resets neither at a collection nor at a chunk boundary — so this walks the
// chunks in cursor order and produces the run's whole variable order at once.
function decodeNames(chunks) {
  const names = [];
  let previous = "";
  for (const chunk of chunks) {
    for (const collection of chunk.collections) {
      for (const row of collection.rows) {
        previous = previous.slice(0, row[0]) + row[1];
        names.push(previous);
      }
    }
  }
  return names;
}

// Undo the payload's positional row form (see `extract-figma-variables.js`):
// `[prefixLength, nameSuffix, typeCode, ...values]` with the description in the
// slot after the last value, values in the collection's mode order, and an
// alias as a one-element array holding the target's index into the run's
// variable order. `names` is that order, as `decodeNames` rebuilds it; a
// chunk's own rows start at `chunk.from` within it.
//
// The fingerprint is computed over what comes out of here, so the objects must
// come back exactly as the payload encoded them: the same key order, no
// `description` key when there is none, and `valuesByMode` sorted by mode name.
function decodeChunk(chunk, names) {
  let index = chunk.from;
  return chunk.collections.map((collection) => ({
    name: collection.name,
    modes: collection.modes,
    defaultMode: collection.defaultMode,
    remote: collection.remote,
    variables: collection.rows.map((row) => {
      const values = row.slice(3, 3 + collection.modes.length);
      return {
        name: names[index++],
        type: TYPE_NAME[row[2]],
        description: row[3 + collection.modes.length],
        valuesByMode: Object.fromEntries(
          collection.modes
            .map((mode, i) => [
              mode,
              Array.isArray(values[i]) ? { alias: names[values[i][0]] } : values[i],
            ])
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      };
    }),
  }));
}

// Reproduce the payload's hash over every value.
//
// The payload builds each line as the collection name, a space, and the
// variable object as `JSON.stringify` renders it, then joins the lines with
// newlines. Iterating the merged export in file order reproduces the order the
// payload hashed in, so nothing here re-sorts.
function fingerprintOfVariables(collections) {
  const lines = [];
  let total = 0;
  for (const collection of collections) {
    for (const variable of collection.variables) {
      lines.push(`${collection.name} ${JSON.stringify(variable)}`);
      total += 1;
    }
  }
  return fingerprintOfSource(lines.join("\n"), total);
}

// Validate a whole run of chunks, decode them, and return the export object.
// Throws on anything that is not a complete, self-consistent, correctly
// transcribed run.
function mergeChunks(unsorted) {
  // Sort by the cursor the payload reported rather than by filename, so the
  // merge does not depend on how the chunk files happen to be named.
  const chunks = unsorted.slice().sort((a, b) => a.from - b.from);

  const expectedFingerprint = chunks[0].fingerprint;
  const expectedCount = chunks[0].variableCount;
  for (const chunk of chunks) {
    if (chunk.fingerprint !== expectedFingerprint) {
      fail(
        `chunks disagree: fingerprint '${chunk.fingerprint}' != ` +
          `'${expectedFingerprint}'. They came from different pulls; re-run ` +
          `the pull from the start.`,
      );
    }
    if (chunk.variableCount !== expectedCount) {
      fail(`chunks disagree on variableCount: ${chunk.variableCount} != ${expectedCount}`);
    }
  }

  // The cursor ranges must tile [0, variableCount) exactly — no gap, no overlap.
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.from !== cursor) {
      fail(
        `chunk range starts at ${chunk.from}, expected ${cursor}. ` +
          `A chunk is missing or duplicated.`,
      );
    }
    if (chunk.to <= chunk.from) fail(`chunk range ${chunk.from}..${chunk.to} is empty`);
    cursor = chunk.to;
  }
  if (cursor !== expectedCount) {
    fail(`chunks cover ${cursor} of ${expectedCount} variables; the run is incomplete`);
  }
  if (!chunks[chunks.length - 1].done) {
    fail("the last chunk is not marked done; the pull did not finish");
  }

  // A row's name is front-coded against the previous row's, and its alias index
  // addresses the run's whole variable order — both chains span chunks, so the
  // names are rebuilt from every chunk before any chunk is decoded. The ranges
  // tile exactly, so reading the rows in cursor order reproduces the order the
  // payload encoded and indexed against.
  const names = decodeNames(chunks);

  // Merge, concatenating the variables of a collection split across chunks.
  const merged = [];
  for (const chunk of chunks) {
    for (const collection of decodeChunk(chunk, names)) {
      const last = merged.length > 0 ? merged[merged.length - 1] : undefined;
      if (last !== undefined && last.name === collection.name) {
        for (const key of ["modes", "defaultMode", "remote"]) {
          if (JSON.stringify(last[key]) !== JSON.stringify(collection[key])) {
            fail(`${collection.name}: ${key} differs between chunks`);
          }
        }
        last.variables.push(...collection.variables);
        continue;
      }
      if (merged.some((existing) => existing.name === collection.name)) {
        fail(`${collection.name}: collection reappears out of order`);
      }
      merged.push(collection);
    }
  }

  const actualCount = merged.reduce((total, c) => total + c.variables.length, 0);
  if (actualCount !== expectedCount) {
    fail(`merged ${actualCount} variables, but the pull reported ${expectedCount}`);
  }

  const actualFingerprint = fingerprintOfVariables(merged);
  if (actualFingerprint !== expectedFingerprint) {
    fail(
      `fingerprint mismatch: the merged export hashes to '${actualFingerprint}', ` +
        `but Figma reported '${expectedFingerprint}'. A value was mistyped while ` +
        `transcribing a chunk — do not commit this export.`,
    );
  }

  return {
    fingerprint: expectedFingerprint,
    variableCount: expectedCount,
    collections: merged,
  };
}

// --- styles ------------------------------------------------------------------

// Reproduce the payload's hash over every style, as the style type, a space,
// and the style object as `JSON.stringify` renders it, joined with newlines —
// in the payload's type order.
function fingerprintOfStyles(styles) {
  const lines = [];
  let count = 0;
  for (const type of STYLE_TYPES) {
    for (const style of styles[type]) {
      lines.push(`${type} ${JSON.stringify(style)}`);
      count += 1;
    }
  }
  return { fingerprint: fingerprintOfSource(lines.join("\n"), count), count };
}

// Validate a style pull and return the export object. Throws on anything that
// is not a completely and correctly transcribed pull.
function mergePull(pull) {
  const { fingerprint, count } = fingerprintOfStyles(pull.styles);

  // Checked before the fingerprint, which would also fail here, because a
  // missing style deserves to be reported as a missing style.
  if (count !== pull.styleCount) {
    fail(
      `the pull holds ${count} styles, but Figma reported ${pull.styleCount}. ` +
        `A style was dropped while transcribing — do not commit this export.`,
    );
  }
  if (fingerprint !== pull.fingerprint) {
    fail(
      `fingerprint mismatch: the pull hashes to '${fingerprint}', but Figma ` +
        `reported '${pull.fingerprint}'. A value was mistyped while ` +
        `transcribing — do not commit this export.`,
    );
  }

  // One pull, one export: the three style types arrive together and stay
  // together, in the shape the payload returned them.
  return { fingerprint: pull.fingerprint, styleCount: pull.styleCount, styles: pull.styles };
}

export { VARIABLES_PATH, STYLES_PATH, decodeNames, decodeChunk, mergeChunks, mergePull };

// --- cli ---------------------------------------------------------------------

// The CLI path runs only when this file is the entry point, so a contract test
// can import the functions above without a merge writing over the committed
// exports.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const [mode, ...files] = process.argv.slice(2);
  if (mode !== "variables" && mode !== "styles") {
    console.error(`${PROGRAM}: first argument must be 'variables' or 'styles', not '${mode}'`);
    process.exit(1);
  }

  let inputs;
  try {
    // A style pull is one file, so only the first argument is read for it.
    inputs = readJsonFiles(mode === "styles" ? files.slice(0, 1) : files);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  let exported;
  try {
    exported = mode === "variables" ? mergeChunks(inputs) : mergePull(inputs[0]);
  } catch (error) {
    console.error(`${PROGRAM}: ${error.message}`);
    process.exit(1);
  }

  const outPath = mode === "variables" ? VARIABLES_PATH : STYLES_PATH;
  fs.writeFileSync(outPath, `${JSON.stringify(exported, null, 2)}\n`);

  console.log(path.relative(ROOT, outPath));
  if (mode === "variables") {
    console.log(`  fingerprint  ${exported.fingerprint} (verified)`);
    for (const collection of exported.collections) {
      console.log(
        `  ${collection.name.padEnd(12)} ${String(collection.variables.length).padStart(3)} variables`,
      );
    }
    console.log(
      `  ${"total".padEnd(12)} ${String(exported.variableCount).padStart(3)} variables from ${inputs.length} chunks`,
    );
  } else {
    for (const type of STYLE_TYPES) {
      console.log(`  ${String(exported.styles[type].length).padStart(3)} ${type} styles`);
    }
    console.log(`  fingerprint  ${exported.fingerprint} (verified)`);
  }
}
