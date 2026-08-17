// Plugin API payload for the /import-variables skill — the `code`
// argument to `mcp__figma__use_figma`.
//
// This file is passed to use_figma VERBATIM: the skill reads it and forwards
// the contents unaltered, never retyping or paraphrasing it inline. That
// discipline is what makes the script on disk provably the one that ran — an
// MCP payload the agent retypes is a payload that drifts from its committed
// source silently.
//
// Colours are converted to hex HERE rather than left as {r,g,b,a} floats. This
// is deterministic version-controlled code running in Figma, not LLM judgment,
// so it does not reintroduce the reproducibility problem that JSON+codegen
// exists to prevent — and it matters because the agent cannot pipe tool output
// to disk: it retypes it. 16-significant-figure floats are the worst possible
// thing to retype hundreds of times. Hex loses no precision CSS can represent
// (a hex colour is 8-bit per channel) and makes the committed diff
// human-reviewable.
//
// THE PULL IS CHUNKED, because a tool result is truncated at roughly 20kB and
// the variable set is already twice that. A truncated result is the exact
// failure the count guard exists to catch: variables silently lost in
// transport. So each call returns as many variables as fit in a conservative
// budget and leaves a cursor behind; the skill calls this same file again,
// unchanged, until it reports `done: true`.
//
// THE CHUNK PAYLOAD IS COMPRESSED STRUCTURALLY, for the same reason: every byte
// on the wire is a byte the agent retypes, and every retyped byte is a chance
// to corrupt a value. A variable ships as a positional row rather than an
// object — the key names, the mode name and the alias target's full path are
// all redundant across hundreds of variables, so the row carries only what
// differs and the collection header carries the rest. The compression is
// schema-level, not a general-purpose compressor, so the wire form stays
// reviewable and a mistyped character fails loudly rather than decoding to
// garbage.
//
// It sits strictly between the two ends of the fingerprint below: the hash is
// taken over the uncompressed encoded objects, and the merge recomputes it over
// the objects it decodes back out. Compression therefore cannot weaken the
// transcription guard.
//
// The cursor lives in the document's shared plugin data because use_figma
// passes no arguments — `code` is the only input channel, and editing the code
// to carry a chunk index is exactly the verbatim violation above. Shared
// plugin data is the one writable, readable side channel the Plugin API offers.
// It is namespaced, it holds a single small integer, and it resets itself when
// the run finishes, so it leaves no lasting mark on the design file.

const NAMESPACE = "crd_test_design_tokens";
const CURSOR_KEY = "exportCursor";
const FINGERPRINT_KEY = "exportFingerprint";

// Well under the ~20kB result cap, leaving room for the envelope around the
// collections array and for a single oversized variable.
const CHUNK_BUDGET = 12000;

const TYPE_CODE = { FLOAT: "F", COLOR: "C", STRING: "S", BOOLEAN: "B" };

const hex = (c) => {
  const to255 = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
  const rgb = `#${to255(c.r)}${to255(c.g)}${to255(c.b)}`.toUpperCase();
  return c.a === undefined || c.a === 1 ? rgb : `${rgb}${to255(c.a).toUpperCase()}`;
};

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const variables = await figma.variables.getLocalVariablesAsync();

// Mode IDs are opaque and unstable across files; map them to mode names so the
// committed JSON survives a mode being renamed or reordered.
const modeName = new Map();
for (const c of collections) {
  for (const m of c.modes) modeName.set(`${c.id}:${m.modeId}`, m.name);
}

// Variable IDs are just as opaque, and an alias stores the target's ID. Resolve
// it to the target's name so the committed export stays readable and stable.
const variableName = new Map(variables.map((v) => [v.id, v.name]));

const byName = (a, b) => a.name.localeCompare(b.name);

// Sorted throughout, so a re-pull produces a diff of what the designer actually
// changed rather than of whatever order Figma happened to return — and so the
// cursor below addresses the same variable on every call.
const ordered = [];
for (const c of collections.slice().sort(byName)) {
  for (const v of variables.filter((v) => v.variableCollectionId === c.id).sort(byName)) {
    ordered.push({ collection: c, variable: v });
  }
}

const orderIndex = new Map(ordered.map((e, i) => [e.variable.id, i]));

// How many leading characters two names share. Names are sorted, so adjacent
// ones share long path prefixes (`colour/black-alpha/10`, `…/20`, `…/40`) and
// front-coding against the previous name roughly halves what the agent retypes.
const sharedPrefix = (previous, name) => {
  const limit = Math.min(previous.length, name.length);
  let i = 0;
  while (i < limit && previous[i] === name[i]) i++;
  return i;
};

// The wire form of one variable: `[prefixLength, nameSuffix, typeCode,
// ...values]`, with the description occupying the slot after the last value
// when the variable has one.
//
// The name is front-coded: `prefixLength` characters of the PREVIOUS name in
// `ordered` followed by `nameSuffix`. The chain runs across the whole pull and
// never resets — not at a collection boundary, not at a chunk boundary — so a
// chunk cannot be decoded alone. That costs nothing, because the merge already
// has to walk every chunk's rows in cursor order before decoding any of them:
// an alias index addresses the same run-wide order.
//
// Values run in the collection's mode order — the collection header hoists the
// mode names, so a row never repeats them — and an alias is a one-element array
// holding the target's index into `ordered`. Wrapping the index in an array is
// what keeps an alias distinguishable from a FLOAT value that happens to be the
// same number.
const row = (c, v, previousName) => {
  const values = c.modes.map((m) => {
    const value = v.valuesByMode[m.modeId];
    if (value !== null && typeof value === "object" && value.type === "VARIABLE_ALIAS") {
      return [orderIndex.get(value.id)];
    }
    return value !== null && typeof value === "object" && "r" in value ? hex(value) : value;
  });
  const shared = sharedPrefix(previousName, v.name);
  const encoded = [shared, v.name.slice(shared), TYPE_CODE[v.resolvedType], ...values];
  if (v.description) encoded.push(v.description);
  return encoded;
};

const encode = (c, v) => ({
  name: v.name,
  type: v.resolvedType,
  description: v.description || undefined,
  valuesByMode: Object.fromEntries(
    Object.entries(v.valuesByMode)
      .map(([id, value]) => [
        modeName.get(`${c.id}:${id}`) || id,
        value !== null && typeof value === "object" && value.type === "VARIABLE_ALIAS"
          ? { alias: variableName.get(value.id) || value.id }
          : value !== null && typeof value === "object" && "r" in value
            ? hex(value)
            : value,
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  ),
});

// The fingerprint covers every encoded value, not just the names, and it does
// double duty.
//
// It guards the cursor: a cursor is only meaningful against the variable set it
// was taken from, so if a designer changes anything mid-run the fingerprint
// changes, the cursor is discarded, and the run restarts from the beginning
// rather than stitching together two versions of the file.
//
// It also guards the transcription. The agent cannot pipe this result to disk —
// it retypes it — and a count catches a variable that went missing but not a
// hex digit that came out wrong. Recomputing this same hash over the committed
// export turns that silent corruption into a loud mismatch. The hash is plain
// 32-bit `h = h * 31 + charCode`, so any language can reproduce it.
const fingerprintSource = ordered
  .map((e) => `${e.collection.name} ${JSON.stringify(encode(e.collection, e.variable))}`)
  .join("\n");
let hash = 0;
for (let i = 0; i < fingerprintSource.length; i++) {
  hash = (Math.imul(hash, 31) + fingerprintSource.charCodeAt(i)) | 0;
}
const fingerprint = `${ordered.length}:${(hash >>> 0).toString(36)}`;

let cursor = 0;
if (figma.root.getSharedPluginData(NAMESPACE, FINGERPRINT_KEY) === fingerprint) {
  cursor = parseInt(figma.root.getSharedPluginData(NAMESPACE, CURSOR_KEY) || "0", 10);
}
if (!Number.isInteger(cursor) || cursor < 0 || cursor >= ordered.length) cursor = 0;

const chunk = [];
let bytes = 0;
let index = cursor;
for (; index < ordered.length; index++) {
  const { collection, variable } = ordered[index];
  const encoded = row(collection, variable, index > 0 ? ordered[index - 1].variable.name : "");
  const cost = JSON.stringify(encoded).length + 1;
  // Always emit at least one variable, so an oversized variable cannot stall
  // the run in an infinite loop of empty chunks.
  if (chunk.length > 0 && bytes + cost > CHUNK_BUDGET) break;
  let target = chunk.length > 0 ? chunk[chunk.length - 1] : undefined;
  if (target === undefined || target.name !== collection.name) {
    target = {
      name: collection.name,
      modes: collection.modes.map((m) => m.name),
      defaultMode: modeName.get(`${collection.id}:${collection.defaultModeId}`),
      remote: collection.remote,
      rows: [],
    };
    chunk.push(target);
    bytes += JSON.stringify(target).length;
  }
  target.rows.push(encoded);
  bytes += cost;
}

const done = index >= ordered.length;

// Finishing clears the cursor, so the next pull starts from the top without the
// caller having to reset anything.
figma.root.setSharedPluginData(NAMESPACE, FINGERPRINT_KEY, done ? "" : fingerprint);
figma.root.setSharedPluginData(NAMESPACE, CURSOR_KEY, done ? "0" : String(index));

// `return` is use_figma's only output channel — console.log is never returned,
// and the return value is JSON-serialized automatically.
return {
  variableCount: variables.length,
  fingerprint,
  from: cursor,
  to: index,
  done,
  collections: chunk,
};
