// Plugin API payload for the /import-variables skill — the `code`
// argument to `mcp__figma__use_figma`.
//
// This file is passed to use_figma VERBATIM: the skill reads it and forwards
// the contents unaltered, never retyping or paraphrasing it inline. That
// discipline is what makes the script on disk provably the one that ran — an
// MCP payload the agent retypes is a payload that drifts from its committed
// source silently.
//
// Styles are a separate Plugin API surface from variables, so this is a second
// pull beside `extract-figma-variables.js` rather than an extension of it. It
// is not chunked and not compressed: all three style dumps together sit well
// inside the ~20kB tool-result cap, so a style ships as a plain object.
//
// BINDINGS ARE RECORDED AS VARIABLE NAMES, NEVER AS RESOLVED VALUES. This is
// the whole trap of the styles API. A gradient stop bound to a colour variable
// still reports a fully resolved `{r,g,b,a}` in `gradientStops[].color`; the
// binding lives beside it in `gradientStops[].boundVariables.color`. A text
// style is the same trap in a different place: `fontName`, `fontSize`,
// `lineHeight` and `letterSpacing` all report resolved values while the
// bindings sit in the style's own `boundVariables` map. A payload that reads
// the resolved value produces an export that looks complete and has silently
// lost every binding in the file. Alias IDs are opaque and unstable, so they
// are resolved to variable names here, exactly as the variable payload resolves
// its alias targets.
//
// Colours are converted to hex HERE, for the same reason as in the variable
// payload: the agent cannot pipe tool output to disk, it retypes it, and
// 16-significant-figure floats are the worst possible thing to retype.
//
// The count and fingerprint below span all three style types in a fixed order,
// so adding a type extends the table rather than rewriting the guard.

const STYLE_TYPES = ["paint", "text", "effect"];

const hex = (c) => {
  const to255 = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
  const rgb = `#${to255(c.r)}${to255(c.g)}${to255(c.b)}`.toUpperCase();
  return c.a === undefined || c.a === 1 ? rgb : `${rgb}${to255(c.a).toUpperCase()}`;
};

const paintStyles = await figma.getLocalPaintStylesAsync();
const textStyles = await figma.getLocalTextStylesAsync();
const effectStyles = await figma.getLocalEffectStylesAsync();
const variables = await figma.variables.getLocalVariablesAsync();

// A binding stores its target's ID, and IDs are opaque. Resolve to the name so
// the committed export stays readable and survives Figma reissuing IDs.
const variableName = new Map(variables.map((v) => [v.id, v.name]));
const nameOf = (binding) => variableName.get(binding.id) || binding.id;

// A bound field becomes the variable's name; only an unbound one is worth a
// value at all.
const encodeBound = (value, binding) => (binding ? { variable: nameOf(binding) } : value);

const encodePaint = (paint) => {
  const encoded = { type: paint.type };
  if (paint.visible === false) encoded.visible = false;
  if (paint.opacity !== undefined && paint.opacity !== 1) encoded.opacity = paint.opacity;
  if (paint.blendMode !== undefined && paint.blendMode !== "NORMAL") {
    encoded.blendMode = paint.blendMode;
  }
  if (paint.gradientStops !== undefined) {
    // The transform carries the gradient's angle, scale and origin; without it
    // the stops describe a ramp with no direction.
    encoded.gradientTransform = paint.gradientTransform;
    encoded.gradientStops = paint.gradientStops.map((stop) => ({
      position: stop.position,
      color: encodeBound(hex(stop.color), stop.boundVariables && stop.boundVariables.color),
    }));
  } else if (paint.color !== undefined) {
    encoded.color = encodeBound(hex(paint.color), paint.boundVariables && paint.boundVariables.color);
  }
  return encoded;
};

const encodePaintStyle = (style) => {
  const encoded = { name: style.name };
  if (style.description) encoded.description = style.description;
  encoded.paints = style.paints.map(encodePaint);
  return encoded;
};

// `lineHeight` and `letterSpacing` are `{unit, value}`, and the unit is the
// whole reason the text styles are worth pulling: it says PIXELS where the
// bound variable holds a bare FLOAT. So the wrapper is kept and the binding
// goes inside it, rather than replacing it.
const encodeMeasure = (measure, binding) =>
  binding ? { unit: measure.unit, variable: nameOf(binding) } : measure;

const encodeTextStyle = (style) => {
  const bound = style.boundVariables || {};
  const encoded = { name: style.name };
  if (style.description) encoded.description = style.description;
  encoded.fontFamily = encodeBound(style.fontName.family, bound.fontFamily);
  encoded.fontStyle = encodeBound(style.fontName.style, bound.fontStyle);
  encoded.fontSize = encodeBound(style.fontSize, bound.fontSize);
  encoded.lineHeight = encodeMeasure(style.lineHeight, bound.lineHeight);
  encoded.letterSpacing = encodeMeasure(style.letterSpacing, bound.letterSpacing);
  // None of these has a variable type in Figma, so the text style is the only
  // place they exist and they are always written out.
  encoded.textCase = style.textCase;
  encoded.textDecoration = style.textDecoration;
  encoded.paragraphIndent = style.paragraphIndent;
  encoded.paragraphSpacing = style.paragraphSpacing;
  encoded.listSpacing = style.listSpacing;
  encoded.leadingTrim = style.leadingTrim;
  return encoded;
};

// A shadow's geometry and colour are literals on the style — effect styles bind
// nothing — so every field is written out. Dropping them would export the style
// as a name and nothing else.
const encodeEffect = (effect) => ({
  type: effect.type,
  color: hex(effect.color),
  offset: effect.offset,
  radius: effect.radius,
  spread: effect.spread,
  visible: effect.visible,
});

const encodeEffectStyle = (style) => {
  const encoded = { name: style.name };
  if (style.description) encoded.description = style.description;
  encoded.effects = style.effects.map(encodeEffect);
  return encoded;
};

// Sorted, so a re-pull produces a diff of what the designer actually changed
// rather than of whatever order Figma happened to return.
const byName = (a, b) => a.name.localeCompare(b.name);

const styles = {
  paint: paintStyles.slice().sort(byName).map(encodePaintStyle),
  text: textStyles.slice().sort(byName).map(encodeTextStyle),
  effect: effectStyles.slice().sort(byName).map(encodeEffectStyle),
};

// The fingerprint covers every encoded value across all three style types. The
// agent cannot pipe this result to disk — it retypes it — and a count catches a
// style that went missing but not a hex digit that came out wrong. Recomputing
// this same hash in the merge, over what it decodes, turns that silent
// corruption into a loud mismatch. The hash is plain 32-bit
// `h = h * 31 + charCode`, so any language can reproduce it.
const lines = [];
let styleCount = 0;
for (const type of STYLE_TYPES) {
  for (const style of styles[type]) {
    lines.push(`${type} ${JSON.stringify(style)}`);
    styleCount += 1;
  }
}
const fingerprintSource = lines.join("\n");
let hash = 0;
for (let i = 0; i < fingerprintSource.length; i++) {
  hash = (Math.imul(hash, 31) + fingerprintSource.charCodeAt(i)) | 0;
}
const fingerprint = `${styleCount}:${(hash >>> 0).toString(36)}`;

// `return` is use_figma's only output channel — console.log is never returned,
// and the return value is JSON-serialized automatically.
return { styleCount, fingerprint, styles };
