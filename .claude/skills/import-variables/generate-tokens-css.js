// Generate `src/tokens.css` from the Figma exports.
//
// Run it as:
//
//   mise x -- node ./.claude/skills/import-variables/generate-tokens-css.js
//
// Two inputs, both committed beside this script — one per Figma pull: the
// variable export and the style export. One output, `src/tokens.css` in this
// repo — the design
// tokens are what a candidate builds against, and this repo is what a trial
// clones, so the generated CSS is committed here.
//
// The whole design system lands in one stylesheet, because that is the whole
// setup: `src/main.tsx` imports it once, and a component binds a value with
// `var(--token)` or wears a text style with a class. There is no provider, no
// context and no theme object — every collection has a single mode, so there
// is nothing to switch at runtime.
//
// Three tiers, in one `:root` block:
//
//   - Primitives — the raw values, the only place a literal is written down.
//   - Semantic   — what a value is *for*. An alias is emitted as
//                  `var(--primitive)`, never as a copy of the value it
//                  resolves to, so a token that tracks another keeps tracking
//                  it and the primitive tier stays the single source.
//   - Styles     — the Figma paint and effect styles, as composite values
//                  (`linear-gradient(…)`, a `box-shadow` list) built out of
//                  the semantic tokens they bind. Text styles are the one
//                  thing that cannot be a custom property — they set six
//                  properties at once — so they are emitted as classes.
//
// Everything between the exports and the CSS is here, so a regeneration is
// deterministic: same exports, byte-identical output, no Figma access, no
// network, no auth, no agent, no seat.
//
// Every declaration is built and counted in memory first, and the file is
// written once at the end. Anything that goes wrong before then exits non-zero
// with the reason and leaves the previously generated file untouched rather
// than half-written.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
// An optional output path, so a dry run can write somewhere throwaway instead
// of over the committed stylesheet. A run with no argument is the real one.
const OUT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(ROOT, "src/tokens.css");

const VARIABLES_PATH = path.join(__dirname, "figma-variables.json");
const STYLES_PATH = path.join(__dirname, "figma-styles.json");

const PRIMITIVES = "Primitives";
const SEMANTIC = "Semantic";
const GRADIENT_GROUP = "Gradient/";
const SHADOW_GROUP = "Effects/";

function fail(message) {
  console.error(`generate-tokens-css: ${message}`);
  process.exit(1);
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`${file}: no such file. Pull from Figma first (/import-variables).`);
    }
    fail(`${file}: not valid JSON — ${error.message}`);
  }
}

// Order two names the way Figma exported them — the same collation the
// extraction payload sorts by — except that a run of digits compares by value,
// not as text. So a group runs size8, size12, size16 and a ramp runs 50, 100,
// 200 rather than the alphabetical size12, size16, size8 or 100, 200, 50, while
// every non-numeric name keeps its existing place and each group stays
// contiguous for the emit loop's grouping logic.
function byNaturalName(a, b) {
  return a.name.localeCompare(b.name, "en", { numeric: true });
}

// A Figma name is a slash path, and may carry spaces and capitals in a style
// name: `colour/black-alpha/10` -> `colour-black-alpha-10`, `Typography/Body
// Big` -> `typography-body-big`. What comes out is the identifier verbatim, not
// a prettier rename, so a token in the CSS can be traced back to the Figma name
// that produced it by eye.
function cssName(name, where) {
  const ident = name
    .trim()
    .toLowerCase()
    .split(/[\s_/]+/)
    .filter(Boolean)
    .join("-");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ident)) {
    fail(`${where}: '${name}' becomes '${ident}', which is not a usable CSS identifier`);
  }
  return ident;
}

// Every custom property and class in the file, so a name that would be written
// twice is refused rather than letting one declaration quietly win.
const properties = new Map();
const classes = new Map();

function claim(taken, ident, where) {
  if (taken.has(ident)) {
    fail(`${where} and ${taken.get(ident)} both become \`${ident}\`; rename one in Figma.`);
  }
  taken.set(ident, where);
  return ident;
}

// --- values ----------------------------------------------------------------

// `#RRGGBB` or `#RRGGBBAA`, which CSS takes as they stand.
function colour(value, where) {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
    fail(`${where}: expected a 6- or 8-digit hex colour, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

function number(value, where, what) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${where}: expected a number for ${what}, got ${JSON.stringify(value)}`);
  }
  return String(value);
}

// A FLOAT carries no unit in Figma, and CSS needs one. Every float in this
// design system is a length in device-independent pixels, and these two tables
// are how that is asserted rather than assumed: a float whose group or whose
// leaf segment says it is a length becomes `px`, and any other float stops the
// generator. The alternative — defaulting to `px` — would silently turn the
// first ratio or opacity variable a designer adds into a length.
//
// Only a float the export holds *directly* is measured here. An alias is
// emitted as a reference to its target, so it inherits the target's unit.
//
// A group is one or two segments deep, because a file may nest what another
// flattens: `font-size/md` and `font/size/md` are the same ramp under two
// conventions, and `font` alone cannot be the group — `font/family` and
// `font/weight` sit beside the lengths and are not lengths.
const LENGTH_GROUPS = new Set([
  "border-weight",
  "border-width",
  "font-size",
  "font/line-height",
  "font/size",
  "gap",
  "grid",
  "letter-spacing",
  "line-height",
  "padding",
  "radius",
  "size",
  "space",
  "spacing",
]);
const LENGTH_LEAVES = new Set([
  "blur",
  "border-width",
  "icon",
  "line-height",
  "margin",
  "min-height",
  "min-width",
  "radius",
  "size",
  "spacing",
  "spread",
  "x",
  "y",
]);

function isLength(name) {
  const parts = name.split("/");
  return (
    LENGTH_GROUPS.has(parts[0]) ||
    LENGTH_GROUPS.has(parts.slice(0, 2).join("/")) ||
    LENGTH_LEAVES.has(parts[parts.length - 1])
  );
}

function length(name, value, where) {
  if (!isLength(name)) {
    fail(`${where}: no unit rule for a FLOAT named ${JSON.stringify(name)}`);
  }
  return `${number(value, where, "a length")}px`;
}

// Figma stores a weight as the font's style name and a text case as a bare
// word; CSS wants a number and a `text-transform` keyword.
const FONT_WEIGHTS = { Regular: "400", Medium: "500", SemiBold: "600", Bold: "700" };
const TEXT_CASES = {
  AsTyped: "none",
  Lowercase: "lowercase",
  TitleCase: "capitalize",
  Uppercase: "uppercase",
};

// A Figma STRING is untyped; the token's name tells the kinds apart. The
// primitive tier groups them by path prefix — flattened as `font-family/…` or
// nested as `font/family/…`, the same two conventions LENGTH_GROUPS reads —
// while the semantic tier names them by property (`type/body-big/weight`), so
// every form is read.
function stringKind(name, where) {
  const prefixed = (...prefixes) => prefixes.some((prefix) => name.startsWith(prefix));
  if (prefixed("font-family/", "font/family/") || name.endsWith("/font")) return "font-family";
  if (prefixed("font-weight/", "font/weight/") || name.endsWith("/weight")) return "font-weight";
  if (prefixed("text-case/", "font/case/") || name.endsWith("/case")) return "text-case";
  fail(`${where}: no CSS rule for a STRING named ${JSON.stringify(name)}`);
}

function string(name, value, where) {
  const kind = stringKind(name, where);
  if (kind === "font-family") return JSON.stringify(String(value));
  const table = kind === "font-weight" ? FONT_WEIGHTS : TEXT_CASES;
  // Figma writes a weight as the font's own style name, and whether that name
  // carries a space is the font's business rather than the design system's —
  // Inter says `Semi Bold` where the table says `SemiBold`. Matching without
  // spacing keeps one entry per weight instead of one per spelling.
  const key = String(value).replace(/\s+/g, "");
  if (!Object.hasOwn(table, key)) {
    fail(`${where}: no rule for a ${kind} of ${JSON.stringify(value)}`);
  }
  return table[key];
}

// --- variables -------------------------------------------------------------

const variablesExport = read(VARIABLES_PATH);

function collection(name) {
  const found = variablesExport.collections.filter((c) => c.name === name);
  if (found.length === 0) {
    const names = variablesExport.collections.map((c) => c.name).join(", ") || "none";
    fail(`${VARIABLES_PATH}: no '${name}' collection (found: ${names})`);
  }
  return found[0];
}

const collections = [collection(PRIMITIVES), collection(SEMANTIC)];
const byName = new Map();
for (const c of collections) {
  for (const variable of c.variables) byName.set(variable.name, { variable, collection: c });
}

function valueOf(name) {
  const entry = byName.get(name);
  const mode = entry.collection.defaultMode;
  if (!(mode in entry.variable.valuesByMode)) {
    const modes = Object.keys(entry.variable.valuesByMode).join(", ") || "none";
    fail(`${entry.collection.name}/${name}: no value for mode '${mode}' (has: ${modes})`);
  }
  return entry.variable.valuesByMode[mode];
}

function isAlias(value) {
  return value !== null && typeof value === "object" && "alias" in value;
}

// The variable an alias chain ends at — the one that holds a literal. CSS
// resolves a `var()` chain at paint time with nothing to say about a chain that
// dangles or loops, so both are refused here instead.
function terminal(name, where, seen = new Set()) {
  if (!byName.has(name)) fail(`${where}: aliases '${name}', which is in neither collection`);
  if (seen.has(name)) {
    fail(`${where}: alias cycle through '${name}'`);
  }
  seen.add(name);
  const value = valueOf(name);
  return isAlias(value) ? terminal(value.alias, where, seen) : byName.get(name).variable;
}

function declarationValue(variable, where) {
  const value = valueOf(variable.name);
  if (isAlias(value)) {
    terminal(value.alias, where);
    return `var(--${cssName(value.alias, where)})`;
  }
  if (variable.type === "COLOR") return colour(value, where);
  if (variable.type === "FLOAT") return length(variable.name, value, where);
  if (variable.type === "BOOLEAN") return String(value);
  if (variable.type === "STRING") return string(variable.name, value, where);
  fail(`${where}: no CSS rule for a ${variable.type}`);
}

// `/* --- colour ---...--- */`, padded to the 80-column line length.
function section(title) {
  return `  /* --- ${title} `.padEnd(76, "-") + " */";
}

const declarations = [];
for (const c of collections) {
  declarations.push("", `  /* ======== ${c.name} ======== */`);
  let group = null;
  let subgroup = null;
  let headed = false;
  for (const variable of [...c.variables].sort(byNaturalName)) {
    const where = `${c.name}/${variable.name}`;

    // Figma names are paths; the first segment groups them, and inside a group
    // the second separates one ramp from the next.
    const parts = variable.name.split("/");
    if (parts[0] !== group) {
      [group, subgroup, headed] = [parts[0], null, true];
      declarations.push("", section(group));
    }
    const ramp = parts.length > 2 ? parts[1] : null;
    if (ramp !== subgroup && !headed) declarations.push("");
    [subgroup, headed] = [ramp, false];

    const ident = claim(properties, cssName(variable.name, where), where);
    declarations.push(`  --${ident}: ${declarationValue(variable, where)};`);
  }
}

const variableCount = collections.reduce((total, c) => total + c.variables.length, 0);
if (properties.size !== variableCount) {
  fail(`emitted ${properties.size} custom properties from ${variableCount} variables`);
}

// --- styles ----------------------------------------------------------------

// One pull, one export: paint, text and effect styles come back from Figma in a
// single call and stay together in a single file.
const { paint: paintStyles, text: textStyles, effect: effectStyles } = read(STYLES_PATH).styles;

// The custom property a bound style field points at. Every binding in the
// exports names a variable, and CSS would resolve a misspelt `var()` to nothing
// at all, so the name is checked against the export here.
function binding(field, where, what) {
  if (field === null || typeof field !== "object" || typeof field.variable !== "string") {
    fail(`${where}: ${what} is not bound to a Figma variable`);
  }
  if (!byName.has(field.variable)) {
    fail(`${where}: ${what} binds '${field.variable}', which is in neither collection`);
  }
  return `var(--${cssName(field.variable, where)})`;
}

// A bound field that has to carry a unit — a font size, a line height — is only
// usable if the variable behind it ends at a length. Nothing downstream would
// catch it otherwise: `font-size: var(--x)` with a unitless `--x` is not an
// error, it is a font that silently does not render.
function boundLength(field, where, what) {
  const reference = binding(field, where, what);
  const end = terminal(field.variable, where);
  if (end.type !== "FLOAT" || !isLength(end.name)) {
    fail(`${where}: ${what} binds '${field.variable}', which is not a length`);
  }
  return reference;
}

// A gradient or a shadow becomes a custom property in the same `:root` block as
// every variable, so its Figma group is what keeps it from colliding with one.
// A text style becomes a class in its own namespace and needs no such guard, so
// it carries its Figma name unprefixed: `body/md` -> `.body-md`.
function styleGroup(style, group, kind) {
  if (!style.name.startsWith(group)) {
    fail(`${style.name}: no rule for a ${kind} style outside '${group}'`);
  }
  return style.name;
}

// -- gradients

// Six decimal places is finer than any screen, and rounding there is what turns
// Figma's `6.123234262925839e-17` — floating-point noise for cos 90° — into the
// 0 it means. `-0` is the same number as `0` and prints better as one.
function round(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

// A Figma `gradientTransform` as a CSS gradient angle.
//
// The matrix maps normalized object space *to* gradient space, so for a linear
// gradient only its first row matters: the gradient parameter at object point
// (x, y) is `t = a·x + b·y + c`, which means `t` increases along the vector
// (a, b) — in Figma's object space, where y points down. A CSS angle is
// measured clockwise from "to top", so that same direction is
// `atan2(a, -b)`.
//
// What the angle cannot carry is where the ramp *starts*: Figma places the
// gradient's ends with the rest of the matrix, while CSS derives them from the
// box the gradient paints and its angle. For a two-stop ramp across a shape the
// two agree; a gradient whose ends sit inside or outside its shape is an
// approximation, and the stop positions below are the only correction available.
function gradientAngle(transform, where) {
  const [a, b] = transform[0];
  if (a * a + b * b === 0) fail(`${where}: gradient transform has no direction`);
  return `${round((Math.atan2(a, -b) * 180) / Math.PI)}deg`;
}

// The one linear gradient a paint style is. A style painted any other way — a
// radial gradient, an image, a gradient stacked over a fill — would have to be
// flattened or guessed at to reach a single `linear-gradient()`, which nothing
// here has settled a form for.
function linearGradient(style, where) {
  const types = style.paints.map((paint) => paint.type);
  if (types.length !== 1 || types[0] !== "GRADIENT_LINEAR") {
    fail(
      `${where}: no rule for a paint style of ${types.join(" over ") || "no paints"} ` +
        `(only a single GRADIENT_LINEAR is carried)`,
    );
  }
  return style.paints[0];
}

const gradients = [];
for (const style of [...paintStyles].sort(byNaturalName)) {
  const where = styleGroup(style, GRADIENT_GROUP, "paint");
  const ident = claim(properties, cssName(style.name, where), where);
  const paint = linearGradient(style, where);
  const stops = paint.gradientStops.map(
    (stop) =>
      `${binding(stop.color, where, "a stop colour")} ${round(stop.position * 100)}%`,
  );
  gradients.push(
    `  --${ident}: linear-gradient(${gradientAngle(paint.gradientTransform, where)}, ${stops.join(", ")});`,
  );
}

// -- shadows

// The one drop shadow an effect style is. A style that casts several shadows,
// an inner shadow, or a blur has no single `box-shadow` to become, and a hidden
// effect is one Figma is not painting, so none of them has a settled form here.
function dropShadow(style, where) {
  const visible = style.effects.filter((effect) => effect.visible);
  const types = visible.map((effect) => effect.type);
  if (types.length !== 1 || types[0] !== "DROP_SHADOW") {
    fail(
      `${where}: no rule for an effect style of ${types.join(" over ") || "no visible effects"} ` +
        `(only a single visible DROP_SHADOW is carried)`,
    );
  }
  return visible[0];
}

const shadows = [];
for (const style of [...effectStyles].sort(byNaturalName)) {
  const where = styleGroup(style, SHADOW_GROUP, "effect");
  const ident = claim(properties, cssName(style.name, where), where);
  const shadow = dropShadow(style, where);
  const geometry = [
    [shadow.offset.x, "an x offset"],
    [shadow.offset.y, "a y offset"],
    [shadow.radius, "a blur radius"],
    [shadow.spread, "a spread"],
  ].map(([value, what]) => `${number(value, where, what)}px`);
  shadows.push(`  --${ident}: ${geometry.join(" ")} ${colour(shadow.color, where)};`);
}

// -- text styles

// Figma's `textCase` and `textDecoration`, by the CSS keyword each becomes.
// Only Figma's small-caps cases have no keyword to land on — they need a font
// carrying that glyph set, which the export's font need not — and a style in
// one is refused rather than shipped as ORIGINAL.
const TEXT_TRANSFORM = {
  ORIGINAL: "none",
  UPPER: "uppercase",
  LOWER: "lowercase",
  TITLE: "capitalize",
};
const TEXT_DECORATION = {
  NONE: "none",
  UNDERLINE: "underline",
  STRIKETHROUGH: "line-through",
};

function keyword(table, value, where, what) {
  if (!Object.hasOwn(table, value)) {
    fail(`${where}: no rule for a ${what} of ${JSON.stringify(value)}`);
  }
  return table[value];
}

// CSS `letter-spacing` is a length, exactly like Figma's PIXELS measure, so a
// bound one passes straight through. A PERCENT measure of 0 is exactly 0; a
// non-zero PERCENT is a fraction of the font size, which nothing here has
// settled a form for.
function letterSpacing(field, where) {
  if (field.unit === "PIXELS") return boundLength(field, where, "letter spacing");
  if (field.unit === "PERCENT" && field.value === 0) return "0";
  fail(`${where}: no rule for a ${field.unit} letter spacing of ${JSON.stringify(field.value)}`);
}

// The fields that CSS could express but that have no settled rule here. Each
// has a neutral value; a style that moves one off it is refused rather than
// silently losing it, which is the failure this pipeline exists to prevent.
const NEUTRAL = { paragraphIndent: 0, paragraphSpacing: 0, listSpacing: 0 };

function checkNeutral(style, where) {
  for (const [field, neutral] of Object.entries(NEUTRAL)) {
    if (style[field] !== neutral) {
      fail(
        `${where}: no rule for a ${field} of ${JSON.stringify(style[field])} ` +
          `(only ${JSON.stringify(neutral)} is carried)`,
      );
    }
  }
}

const text = [];
for (const style of [...textStyles].sort(byNaturalName)) {
  const where = style.name;
  const ident = claim(classes, cssName(style.name, where), where);
  checkNeutral(style, where);
  text.push(
    "",
    `.${ident} {`,
    `  font-family: ${binding(style.fontFamily, where, "font family")};`,
    `  font-weight: ${binding(style.fontStyle, where, "font weight")};`,
    `  font-size: ${boundLength(style.fontSize, where, "font size")};`,
    `  line-height: ${boundLength(style.lineHeight, where, "line height")};`,
    `  letter-spacing: ${letterSpacing(style.letterSpacing, where)};`,
    `  text-transform: ${keyword(TEXT_TRANSFORM, style.textCase, where, "textCase")};`,
    `  text-decoration: ${keyword(TEXT_DECORATION, style.textDecoration, where, "textDecoration")};`,
    "}",
  );
}

const styleCount = paintStyles.length + effectStyles.length + textStyles.length;
if (properties.size + classes.size !== variableCount + styleCount) {
  fail(
    `emitted ${properties.size + classes.size} declarations from ` +
      `${variableCount} variables and ${styleCount} styles`,
  );
}

// --- output ----------------------------------------------------------------

const file = [
  "/* GENERATED FILE — DO NOT EDIT.",
  " *",
  " * Regenerate with:",
  " *   mise x -- node ./.claude/skills/import-variables/generate-tokens-css.js",
  " *",
  " * Source: the committed Figma variable and style exports. Change a value in",
  " * Figma and re-pull; an edit made here is lost on the next run, and the",
  " * regeneration diff is the review surface.",
  " *",
  " * Bind a value with `var(--token)`; wear a text style with its class.",
  " * `src/main.tsx` imports this file once, so every component sees it.",
  " *",
  " * Three of Figma's fields cannot cross over as they stand:",
  " *",
  " * - Gradient direction. Figma states it as a `gradientTransform`, a 2×3",
  " *   affine matrix mapping the shape's 0..1 space to the gradient's; CSS",
  " *   states it as an angle and derives the ramp's ends from the painted box.",
  " *   The angle comes from the matrix's first row, which alone gives the",
  " *   gradient parameter at a point; the ends are CSS's, so a gradient whose",
  " *   ends sit off its shape in Figma is an approximation here.",
  " * - Text case. CSS `text-transform` covers Figma's four ordinary cases and",
  " *   none of its small-caps ones, which would need a font carrying that",
  " *   glyph set. A style in one fails the generator rather than being",
  " *   approximated.",
  " * - Leading trim. Figma's CAP_HEIGHT and TEXT_BOUNDS have no stable CSS",
  " *   equivalent, so a text style's `leadingTrim` goes no further than Figma.",
  " *   Every style in the current export is NONE, so nothing is being lost",
  " *   today — but unlike the three fields below, a style that moved off it",
  " *   would be dropped silently rather than stopping the generator.",
  " *",
  " * `paragraphIndent`, `paragraphSpacing` and `listSpacing` are all expressible",
  " * in CSS but have no settled rule here, so a style that moves one off its",
  " * neutral value fails the generator rather than quietly losing it.",
  " */",
  "",
  ":root {",
  ...declarations.slice(1),
  "",
  `  /* ======== Figma styles ======== */`,
  "",
  section("gradients"),
  ...gradients,
  "",
  section("shadows"),
  ...shadows,
  "}",
  "",
  "/* ======== Figma text styles ======== */",
  ...text,
  "",
].join("\n");

if (!fs.existsSync(path.dirname(OUT_PATH))) {
  fail(`${OUT_PATH}: no such directory. The builder checkout has to sit beside this repo.`);
}
fs.writeFileSync(OUT_PATH, file);

console.log(path.relative(ROOT, OUT_PATH));
for (const c of collections) {
  console.log(`  ${c.name.padEnd(12)} ${String(c.variables.length).padStart(3)} variables in the export`);
}
for (const [kind, styles] of [
  ["paint", paintStyles],
  ["effect", effectStyles],
  ["text", textStyles],
]) {
  console.log(`  ${kind.padEnd(12)} ${String(styles.length).padStart(3)} styles in the export`);
}
console.log(
  `  ${"emitted".padEnd(12)} ${String(properties.size).padStart(3)} custom properties ` +
    `and ${classes.size} classes (counts agree)`,
);
