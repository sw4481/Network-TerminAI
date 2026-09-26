#!/usr/bin/env node
/**
 * Deterministic WCAG contrast gate for TerminAI's semantic theme contract and
 * the foreground/background combinations that active source CSS actually uses.
 *
 * Source discovery audits rules that directly paint both `color` and a flat
 * `background`/`background-color`, plus conservative interactive-state pairs
 * derived from an identical base selector. Inherited or transparent colors,
 * image/gradient backgrounds, and unpaired state declarations are counted as
 * explicit exclusions instead of silently disappearing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const THEME_IDS = ["terminai-dark", "slate-grey", "matrix"];

const NORMAL_TEXT_PAIRS = [
  ["--text-primary", "--app-canvas"],
  ["--text-primary", "--surface-1"],
  ["--text-primary", "--surface-2"],
  ["--text-primary", "--surface-3"],
  ["--text-primary", "--surface-overlay"],
  ["--text-primary", "--surface-input"],
  ["--text-body", "--app-canvas"],
  ["--text-body", "--surface-2"],
  ["--text-body", "--surface-3"],
  ["--text-secondary", "--app-canvas"],
  ["--text-secondary", "--surface-2"],
  ["--text-secondary", "--surface-3"],
  ["--text-muted", "--app-canvas"],
  ["--text-muted", "--surface-2"],
  ["--text-muted", "--surface-3"],
  ["--text-recording", "--surface-recording"],
  ["--text-recording", "--surface-recording-control"],
  ["--text-recording", "--surface-recording-hover"],
  ["--text-recording-muted", "--surface-recording"],
  ["--text-recording-muted", "--surface-recording-inset"],
  ["--text-recording-muted", "--surface-recording-control"],
  ["--text-recording-muted", "--surface-recording-hover"],
  ["--text-on-strong-accent", "--accent"],
  ["--text-on-accent-hover", "--accent-hover"],
  ["--status-info", "--surface-1"],
  ["--status-success", "--surface-1"],
  ["--status-warning", "--status-warning-surface"],
  ["--status-danger", "--status-danger-surface"],
  ["--status-neutral", "--surface-1"],
  ["--status-recording-failure-text", "--status-recording-failure-surface"],
  ["--troubleshoot-running", "--troubleshoot-running-surface", "--surface-1"],
  ["--tftp-running", "--tftp-running-surface"],
  ["--tftp-error", "--tftp-error-surface"],
  ["--terminal-foreground", "--terminal-background"],
  ["--editor-foreground", "--editor-background"],
].map(([foreground, background, backdrop]) => ({
  foreground,
  background,
  backdrop,
  minimum: 4.5,
}));

const UI_CONTROL_PAIRS = [
  ["--focus-ring", "--app-canvas"],
  ["--focus-ring", "--surface-1"],
  ["--focus-ring", "--surface-2"],
  ["--focus-ring", "--surface-3"],
  ["--focus-ring", "--surface-input"],
  ["--focus-control", "--app-canvas"],
  ["--focus-control", "--surface-2"],
].map(([foreground, background]) => ({ foreground, background, minimum: 3 }));

export const CONTRAST_PAIRS = [...NORMAL_TEXT_PAIRS, ...UI_CONTROL_PAIRS];

const VISUAL_STATE_CONTRACTS = [
  {
    name: "tab operational indicators",
    file: "App.css",
    paintLabel: "background",
    properties: ["background", "background-color"],
    surfaces: ["--surface-2", "--surface-selected"],
    minimum: 3,
    requireDistinct: false,
    states: [
      { label: "recording", selector: ".tab-recording-dot" },
      { label: "needs-attention", selector: ".tab-activity-dot--needs-attention" },
      { label: "running", selector: ".tab-activity-dot--running" },
    ],
  },
  {
    name: "Blast Radius tiers",
    file: "components/BlastRadius/BlastRadius.css",
    paintLabel: "border",
    properties: ["border-color"],
    surfaces: ["--surface-overlay"],
    minimum: 3,
    requireDistinct: true,
    states: [
      { label: "tier-1", selector: ".br-tier-badge.tier-1" },
      { label: "tier-2", selector: ".br-tier-badge.tier-2" },
      { label: "tier-3", selector: ".br-tier-badge.tier-3" },
      { label: "ambiguous", selector: ".br-tier-badge.tier-amb" },
    ],
  },
  {
    name: "Drift report states",
    file: "components/DriftSidebar.css",
    paintLabel: "background",
    properties: ["background", "background-color"],
    surfaces: ["--surface-2", "--surface-selected"],
    minimum: 3,
    requireDistinct: true,
    states: [
      { label: "in-sync", selector: ".drift-status-dot.in_sync" },
      { label: "drift", selector: ".drift-status-dot.drift" },
      { label: "error", selector: ".drift-status-dot.error" },
      { label: "paused", selector: ".drift-status-dot.paused" },
    ],
  },
  {
    name: "Blast Radius rule tiers",
    file: "components/BlastRadius/RuleEditor.css",
    paintLabel: "border",
    properties: ["border-color"],
    surfaces: ["--app-canvas"],
    minimum: 3,
    requireDistinct: true,
    states: [
      { label: "tier-0", selector: ".rule-editor .badge.tier-0" },
      { label: "tier-1", selector: ".rule-editor .badge.tier-1" },
      { label: "tier-2", selector: ".rule-editor .badge.tier-2" },
      { label: "tier-3", selector: ".rule-editor .badge.tier-3" },
    ],
  },
];

function channelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function parseAlpha(value) {
  return value?.endsWith("%") ? Number.parseFloat(value) / 100 : Number(value ?? 1);
}

function parseColor(color) {
  if (typeof color !== "string") return color;
  const normalized = color.trim();
  if (normalized.toLowerCase() === "transparent") {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }
  const hex = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const expanded = hex[1].length === 3
      ? [...hex[1]].map((channel) => `${channel}${channel}`).join("")
      : hex[1];
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const modernRgb = normalized.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?%?))?\s*\)$/i,
  );
  if (modernRgb) {
    return {
      red: Number(modernRgb[1]),
      green: Number(modernRgb[2]),
      blue: Number(modernRgb[3]),
      alpha: parseAlpha(modernRgb[4]),
    };
  }
  const legacyRgb = normalized.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?%?))?\s*\)$/i,
  );
  if (legacyRgb) {
    return {
      red: Number(legacyRgb[1]),
      green: Number(legacyRgb[2]),
      blue: Number(legacyRgb[3]),
      alpha: parseAlpha(legacyRgb[4]),
    };
  }
  throw new Error(`Expected a hex or rgb color, received ${color}`);
}

function composite(foreground, background) {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  return {
    red: (
      foreground.red * foreground.alpha
      + background.red * background.alpha * (1 - foreground.alpha)
    ) / alpha,
    green: (
      foreground.green * foreground.alpha
      + background.green * background.alpha * (1 - foreground.alpha)
    ) / alpha,
    blue: (
      foreground.blue * foreground.alpha
      + background.blue * background.alpha * (1 - foreground.alpha)
    ) / alpha,
    alpha,
  };
}

function opaque(color, backdrop) {
  const parsed = parseColor(color);
  if (parsed.alpha === 1) return parsed;
  if (!backdrop) throw new Error("Translucent color requires a backdrop");
  return composite(parsed, opaque(backdrop));
}

export function relativeLuminance(color, backdrop) {
  const parsed = opaque(color, backdrop);
  const red = channelToLinear(parsed.red);
  const green = channelToLinear(parsed.green);
  const blue = channelToLinear(parsed.blue);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground, background, backdrop) {
  const resolvedBackground = opaque(background, backdrop);
  const resolvedForeground = opaque(foreground, resolvedBackground);
  const foregroundLuminance = relativeLuminance(resolvedForeground);
  const backgroundLuminance = relativeLuminance(resolvedBackground);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

/** Replace CSS comments with spaces while retaining line/character offsets. */
function maskCssComments(css) {
  const output = css.split("");
  let quote = "";
  let escaped = false;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "/" && css[index + 1] === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < css.length) {
        if (css[index] === "*" && css[index + 1] === "/") {
          output[index] = " ";
          output[index + 1] = " ";
          index += 1;
          break;
        }
        if (css[index] !== "\n") output[index] = " ";
        index += 1;
      }
    }
  }
  return output.join("");
}

function quotedEnd(text, open) {
  const quote = text[open];
  let escaped = false;
  for (let index = open + 1; index < text.length; index += 1) {
    if (escaped) escaped = false;
    else if (text[index] === "\\") escaped = true;
    else if (text[index] === quote) return index;
  }
  return text.length - 1;
}

function matchingBraceEnd(text, open, limit = text.length) {
  let depth = 1;
  for (let index = open + 1; index < limit; index += 1) {
    const character = text[index];
    if (character === "'" || character === '"') {
      index = quotedEnd(text, index);
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      return index;
    }
  }
  return limit - 1;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if ("([".includes(character)) depth += 1;
    else if (")]".includes(character)) depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseDeclarations(body, bodyOffset) {
  const declarations = [];
  for (const segment of splitTopLevel(body, ";")) {
    const segmentStart = body.indexOf(segment);
    let colon = -1;
    let depth = 0;
    for (let index = 0; index < segment.length; index += 1) {
      if ("([".includes(segment[index])) depth += 1;
      else if (")]".includes(segment[index])) depth -= 1;
      else if (segment[index] === ":" && depth === 0) {
        colon = index;
        break;
      }
    }
    if (colon < 0) continue;
    const property = segment.slice(0, colon).trim().toLowerCase();
    const value = segment.slice(colon + 1).trim();
    if (!property || !value) continue;
    declarations.push({
      property,
      value,
      offset: bodyOffset + segmentStart + segment.search(/\S/),
    });
  }
  return declarations;
}

function normalizedSelector(selector) {
  return selector.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
}

const INTERACTIVE_STATE_PSEUDOS = new Set([
  "active",
  "checked",
  "disabled",
  "focus",
  "focus-visible",
  "focus-within",
  "hover",
]);

const STATE_ATTRIBUTES = new Set([
  "aria-busy",
  "aria-checked",
  "aria-current",
  "aria-disabled",
  "aria-expanded",
  "aria-hidden",
  "aria-invalid",
  "aria-pressed",
  "aria-selected",
  "checked",
  "data-active",
  "data-checked",
  "data-disabled",
  "data-open",
  "data-selected",
  "data-state",
  "data-status",
  "disabled",
  "open",
  "selected",
]);

function matchingTokenEnd(text, open, opening, closing) {
  let depth = 1;
  let quote = "";
  let escaped = false;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) return index;
  }
  return -1;
}

function isStateAttribute(attributeSelector) {
  const name = attributeSelector.trim().match(/^([a-z_][\w:-]*)/i)?.[1]?.toLowerCase();
  return name != null && STATE_ATTRIBUTES.has(name);
}

function isSupportedStateAtom(selector) {
  const trimmed = selector.trim();
  const pseudo = trimmed.match(/^:([a-z-]+)$/i)?.[1]?.toLowerCase();
  if (pseudo && INTERACTIVE_STATE_PSEUDOS.has(pseudo)) return true;
  return trimmed.startsWith("[")
    && trimmed.endsWith("]")
    && isStateAttribute(trimmed.slice(1, -1));
}

function containsInteractiveState(selector) {
  return /:(?:active|checked|disabled|focus(?:-visible|-within)?|hover)\b/i.test(selector)
    || /\[\s*(?:aria-(?:busy|checked|current|disabled|expanded|hidden|invalid|pressed|selected)|data-(?:active|checked|disabled|open|selected|state|status)|checked|disabled|open|selected)\b/i
      .test(selector);
}

/**
 * Reduce a supported state selector to the exact non-state selector it extends.
 * Functional selector syntax other than a single-state `:not(...)` is left
 * unresolved rather than approximated as a browser selector engine.
 */
function analyzeStateSelector(selector) {
  let base = "";
  let stateful = false;
  let unresolved = false;

  for (let index = 0; index < selector.length;) {
    const character = selector[index];
    if (character === "[") {
      const close = matchingTokenEnd(selector, index, "[", "]");
      if (close < 0) {
        unresolved = true;
        break;
      }
      const token = selector.slice(index, close + 1);
      if (isStateAttribute(token.slice(1, -1))) {
        stateful = true;
      } else {
        base += token;
      }
      index = close + 1;
      continue;
    }
    if (character === ":" && selector[index + 1] !== ":") {
      const nameMatch = selector.slice(index + 1).match(/^([a-z-]+)/i);
      const name = nameMatch?.[1]?.toLowerCase();
      if (name && INTERACTIVE_STATE_PSEUDOS.has(name)) {
        stateful = true;
        index += name.length + 1;
        continue;
      }
      if (name === "not" && selector[index + name.length + 1] === "(") {
        const open = index + name.length + 1;
        const close = matchingTokenEnd(selector, open, "(", ")");
        if (close < 0) {
          unresolved = true;
          break;
        }
        const token = selector.slice(index, close + 1);
        if (isSupportedStateAtom(selector.slice(open + 1, close))) {
          stateful = true;
        } else {
          if (containsInteractiveState(token)) {
            stateful = true;
            unresolved = true;
          }
          base += token;
        }
        index = close + 1;
        continue;
      }
      if (name) {
        const afterName = index + name.length + 1;
        if (selector[afterName] === "(") {
          const close = matchingTokenEnd(selector, afterName, "(", ")");
          if (close < 0) {
            unresolved = true;
            break;
          }
          const token = selector.slice(index, close + 1);
          if (containsInteractiveState(token)) {
            stateful = true;
            unresolved = true;
          }
          base += token;
          index = close + 1;
          continue;
        }
      }
    }
    base += character;
    index += 1;
  }

  const baseSelector = normalizedSelector(base)
    .replace(/\s*([>+~])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    stateful,
    baseSelector: unresolved || !baseSelector ? null : baseSelector,
  };
}

function cssRules(css) {
  const text = maskCssComments(css);
  const rules = [];
  const containerAtRules = /^@(media|supports|layer|container|scope|document)\b/i;

  function visit(start, end) {
    let statementStart = start;
    for (let index = start; index < end; index += 1) {
      const character = text[index];
      if (character === "'" || character === '"') {
        index = quotedEnd(text, index);
        continue;
      }
      if (character === ";") {
        statementStart = index + 1;
        continue;
      }
      if (character !== "{") continue;
      const close = matchingBraceEnd(text, index, end);
      const prelude = text.slice(statementStart, index).trim();
      const preludeOffset = statementStart + Math.max(text.slice(statementStart, index).search(/\S/), 0);
      if (prelude.startsWith("@")) {
        if (containerAtRules.test(prelude)) visit(index + 1, close);
      } else if (prelude) {
        rules.push({
          selector: normalizedSelector(prelude),
          offset: preludeOffset,
          declarations: parseDeclarations(text.slice(index + 1, close), index + 1),
        });
      }
      index = close;
      statementStart = close + 1;
    }
  }

  visit(0, text.length);
  return { rules, text };
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

export function parseThemeTokens(css) {
  const { rules } = cssRules(css);
  const themes = new Map(THEME_IDS.map((themeId) => [themeId, new Map()]));
  const rootTokens = new Map();
  for (const rule of rules) {
    const customProperties = rule.declarations.filter(({ property }) => property.startsWith("--"));
    if (rule.selector === ":root") {
      for (const declaration of customProperties) {
        rootTokens.set(declaration.property, declaration.value);
      }
    }
    for (const themeId of THEME_IDS) {
      if (!rule.selector.includes(`html[data-theme="${themeId}"]`)) continue;
      for (const declaration of customProperties) {
        themes.get(themeId).set(declaration.property, declaration.value);
      }
    }
  }
  for (const tokens of themes.values()) {
    for (const [property, value] of rootTokens) {
      if (!tokens.has(property)) tokens.set(property, value);
    }
  }
  return themes;
}

function exactFunction(expression, name) {
  const trimmed = expression.trim();
  if (!trimmed.toLowerCase().startsWith(`${name}(`)) return null;
  let depth = 0;
  for (let index = name.length; index < trimmed.length; index += 1) {
    if (trimmed[index] === "(") depth += 1;
    else if (trimmed[index] === ")" && --depth === 0) {
      return index === trimmed.length - 1
        ? trimmed.slice(name.length + 1, index)
        : null;
    }
  }
  return null;
}

function resolvedColor(color, label) {
  return { color, label, value: colorToString(color) };
}

function colorToString(color) {
  const alpha = Math.round(color.alpha * 10000) / 100;
  return color.alpha === 1
    ? `rgb(${color.red} ${color.green} ${color.blue})`
    : `rgb(${color.red} ${color.green} ${color.blue} / ${alpha}%)`;
}

function mixColors(first, second, firstWeight, secondWeight) {
  const total = firstWeight + secondWeight;
  const normalizedFirst = firstWeight / total;
  const normalizedSecond = secondWeight / total;
  const alpha = first.alpha * normalizedFirst + second.alpha * normalizedSecond;
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  return {
    red: (
      first.red * first.alpha * normalizedFirst
      + second.red * second.alpha * normalizedSecond
    ) / alpha,
    green: (
      first.green * first.alpha * normalizedFirst
      + second.green * second.alpha * normalizedSecond
    ) / alpha,
    blue: (
      first.blue * first.alpha * normalizedFirst
      + second.blue * second.alpha * normalizedSecond
    ) / alpha,
    alpha,
  };
}

function mixStop(stop) {
  const match = stop.trim().match(/^([\s\S]*?)(?:\s+(\d+(?:\.\d+)?)%)?$/);
  return { expression: match[1].trim(), weight: match[2] == null ? null : Number(match[2]) / 100 };
}

function resolveTextVars(expression, tokens, seen) {
  let output = "";
  for (let index = 0; index < expression.length;) {
    if (expression.slice(index, index + 4).toLowerCase() !== "var(") {
      output += expression[index];
      index += 1;
      continue;
    }
    let depth = 1;
    let close = index + 4;
    for (; close < expression.length && depth > 0; close += 1) {
      if (expression[close] === "(") depth += 1;
      else if (expression[close] === ")") depth -= 1;
    }
    if (depth !== 0) return null;
    const contents = expression.slice(index + 4, close - 1);
    const [name, ...fallbackParts] = splitTopLevel(contents, ",").map((part) => part.trim());
    let replacement = tokens.get(name);
    if (replacement == null) replacement = fallbackParts.join(",").trim() || null;
    if (replacement == null || seen.has(name)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    const resolved = resolveTextVars(replacement, tokens, nextSeen);
    if (resolved == null) return null;
    output += resolved;
    index = close;
  }
  return output;
}

function resolveColorExpression(expression, tokens, seen = new Set()) {
  const cleaned = expression.replace(/\s*!important\s*$/i, "").trim();
  const variable = exactFunction(cleaned, "var");
  if (variable != null) {
    const [name, ...fallbackParts] = splitTopLevel(variable, ",").map((part) => part.trim());
    const tokenValue = tokens.get(name);
    if (tokenValue != null && !seen.has(name)) {
      const nextSeen = new Set(seen);
      nextSeen.add(name);
      const resolved = resolveColorExpression(tokenValue, tokens, nextSeen);
      return resolved ? { ...resolved, label: name } : null;
    }
    const fallback = fallbackParts.join(",").trim();
    return fallback ? resolveColorExpression(fallback, tokens, seen) : null;
  }

  const mix = exactFunction(cleaned, "color-mix");
  if (mix != null) {
    const parts = splitTopLevel(mix, ",").map((part) => part.trim());
    if (!/^in\s+srgb$/i.test(parts[0]) || parts.length !== 3) return null;
    const firstStop = mixStop(parts[1]);
    const secondStop = mixStop(parts[2]);
    const first = resolveColorExpression(firstStop.expression, tokens, seen);
    const second = resolveColorExpression(secondStop.expression, tokens, seen);
    if (!first || !second) return null;
    const firstWeight = firstStop.weight ?? (secondStop.weight == null ? 0.5 : 1 - secondStop.weight);
    const secondWeight = secondStop.weight ?? (firstStop.weight == null ? 0.5 : 1 - firstStop.weight);
    return resolvedColor(
      mixColors(first.color, second.color, firstWeight, secondWeight),
      cleaned.replace(/\s+/g, " "),
    );
  }

  const substituted = resolveTextVars(cleaned, tokens, seen);
  if (substituted == null) return null;
  try {
    return resolvedColor(parseColor(substituted), cleaned);
  } catch {
    return null;
  }
}

function cssFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((first, second) => first.name.localeCompare(second.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".css")) files.push(path);
    }
  }
  visit(root);
  return files;
}

function finalDeclaration(rule, properties) {
  return rule.declarations.findLast(({ property }) => properties.includes(property));
}

function discoverVisualStateGroups(parsedFiles) {
  const groups = [];
  for (const contract of VISUAL_STATE_CONTRACTS) {
    const parsed = parsedFiles.get(contract.file);
    if (!parsed) {
      groups.push({
        name: contract.name,
        file: contract.file,
        surfaces: contract.surfaces,
        minimum: contract.minimum,
        requireDistinct: contract.requireDistinct,
        error: "missing contracted CSS file",
        entries: [],
      });
      continue;
    }
    const entries = contract.states.map((state) => {
      const matchingRules = parsed.rules.filter((rule) => (
        splitTopLevel(rule.selector, ",")
          .map((selector) => normalizedSelector(selector))
          .includes(state.selector)
      ));
      const combined = {
        declarations: matchingRules.flatMap(({ declarations }) => declarations),
      };
      const paint = finalDeclaration(combined, contract.properties);
      const lastRule = matchingRules.at(-1);
      return {
        ...state,
        file: contract.file,
        line: lastRule ? lineAt(parsed.text, lastRule.offset) : 1,
        paint: paint?.value ?? null,
        error: paint ? null : `missing ${contract.paintLabel} paint`,
      };
    });
    groups.push({
      name: contract.name,
      surfaces: contract.surfaces,
      minimum: contract.minimum,
      requireDistinct: contract.requireDistinct,
      entries,
    });
  }
  return groups;
}

function cascadedRule(baseEntries, stateEntries) {
  return {
    declarations: [...baseEntries, ...stateEntries].flatMap((entry) => (
      entry.declarations.map((declaration) => ({
        ...declaration,
        sourceRule: entry.ruleIndex,
      }))
    )),
  };
}

function directPairThreshold(rule) {
  const fontSizeDeclaration = finalDeclaration(rule, ["font-size"]);
  const fontWeightDeclaration = finalDeclaration(rule, ["font-weight"]);
  const size = fontSizeDeclaration?.value.match(/^(\d+(?:\.\d+)?)(px|pt|rem|em)$/i);
  const pixels = !size ? 0
    : Number(size[1]) * (size[2].toLowerCase() === "pt" ? 4 / 3
      : ["rem", "em"].includes(size[2].toLowerCase()) ? 16 : 1);
  const weightValue = fontWeightDeclaration?.value.trim().toLowerCase();
  const weight = weightValue === "bold" ? 700 : Number(weightValue ?? 400);
  return pixels >= 24 || (pixels >= 18.66 && weight >= 700) ? 3 : 4.5;
}

function exclusionReason(foreground, background) {
  const normalizedForeground = foreground.toLowerCase().trim();
  const normalizedBackground = background.toLowerCase().trim();
  if (/^(inherit|initial|unset|revert|revert-layer|currentcolor)$/.test(normalizedForeground)) {
    return "inherited foreground";
  }
  if (/^(none|transparent|inherit|initial|unset|revert|revert-layer)$/.test(normalizedBackground)) {
    return "no flat painted background";
  }
  if (/\b(?:url|image-set|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient)\s*\(/i
    .test(normalizedBackground)) {
    return "image or gradient background";
  }
  return null;
}

export function discoverCssContrastUsages(sourceRoot) {
  const root = resolve(sourceRoot);
  const usages = [];
  const exclusions = [];
  const cascadeExclusions = [];
  const parsedFiles = new Map();
  for (const path of cssFiles(root)) {
    const css = readFileSync(path, "utf8");
    const parsed = cssRules(css);
    const file = relative(root, path).split(sep).join("/");
    parsedFiles.set(file, parsed);
    const branches = [];
    for (const [ruleIndex, rule] of parsed.rules.entries()) {
      const foreground = finalDeclaration(rule, ["color"]);
      const background = finalDeclaration(rule, ["background", "background-color"]);
      if (foreground && background) {
        const exclusion = exclusionReason(foreground.value, background.value);
        const context = {
          file,
          line: lineAt(parsed.text, rule.offset),
          selector: rule.selector,
        };
        if (exclusion) {
          exclusions.push({ ...context, reason: exclusion });
        } else {
          usages.push({
            ...context,
            source: "direct",
            foreground: foreground.value,
            background: background.value,
            minimum: directPairThreshold(rule),
            localTokens: new Map(
              rule.declarations
                .filter(({ property }) => property.startsWith("--"))
                .map(({ property, value }) => [property, value]),
            ),
          });
        }
      }

      for (const selector of splitTopLevel(rule.selector, ",")
        .map((branch) => normalizedSelector(branch))
        .filter(Boolean)) {
        const analysis = analyzeStateSelector(selector);
        branches.push({
          ruleIndex,
          rule,
          selector,
          ...analysis,
          paintsContrastSide: Boolean(foreground || background),
        });
      }
    }

    const baseEntries = new Map();
    const stateEntries = new Map();
    for (const branch of branches) {
      if (!branch.stateful) {
        const entries = baseEntries.get(branch.selector) ?? [];
        entries.push({ ruleIndex: branch.ruleIndex, declarations: branch.rule.declarations });
        baseEntries.set(branch.selector, entries);
        continue;
      }
      if (!branch.paintsContrastSide) continue;
      if (!branch.baseSelector) {
        cascadeExclusions.push({
          file,
          line: lineAt(parsed.text, branch.rule.offset),
          selector: branch.selector,
          reason: "unsupported interactive-state selector",
        });
        continue;
      }
      const key = `${branch.baseSelector}\u0000${branch.selector}`;
      const group = stateEntries.get(key) ?? {
        baseSelector: branch.baseSelector,
        selector: branch.selector,
        entries: [],
      };
      group.entries.push({
        ruleIndex: branch.ruleIndex,
        declarations: branch.rule.declarations,
        offset: branch.rule.offset,
      });
      stateEntries.set(key, group);
    }

    for (const group of stateEntries.values()) {
      const base = baseEntries.get(group.baseSelector) ?? [];
      const combined = cascadedRule(base, group.entries);
      const foreground = finalDeclaration(combined, ["color"]);
      const background = finalDeclaration(combined, ["background", "background-color"]);
      const contextEntry = group.entries.at(-1);
      const context = {
        file,
        line: lineAt(parsed.text, contextEntry.offset),
        selector: group.selector,
      };
      if (!foreground || !background) {
        cascadeExclusions.push({
          ...context,
          reason: `unresolved cascaded ${!foreground ? "foreground" : "background"}`,
        });
        continue;
      }

      // A state rule that directly supplies the final pair was already audited
      // above. Add only pairs assembled across base/state declarations.
      if (foreground.sourceRule === background.sourceRule
        && group.entries.some(({ ruleIndex }) => ruleIndex === foreground.sourceRule)) {
        continue;
      }
      const exclusion = exclusionReason(foreground.value, background.value);
      if (exclusion) {
        exclusions.push({ ...context, reason: exclusion });
        continue;
      }
      usages.push({
        ...context,
        source: "derived-state",
        foreground: foreground.value,
        background: background.value,
        minimum: directPairThreshold(combined),
        localTokens: new Map(
          combined.declarations
            .filter(({ property }) => property.startsWith("--"))
            .map(({ property, value }) => [property, value]),
        ),
      });
    }
  }
  return {
    usages,
    exclusions,
    cascadeExclusions,
    visualGroups: discoverVisualStateGroups(parsedFiles),
  };
}

export function auditThemeContrast(
  css,
  discovery = {
    usages: [],
    exclusions: [],
    cascadeExclusions: [],
    visualGroups: [],
  },
) {
  const themes = parseThemeTokens(css);
  const findings = [];
  const unsupportedUsages = new Set();
  for (const themeId of THEME_IDS) {
    const tokens = themes.get(themeId);
    if (!tokens || tokens.size === 0) {
      findings.push({ kind: "semantic", themeId, error: "theme block is missing" });
      continue;
    }
    for (const pair of CONTRAST_PAIRS) {
      const foreground = resolveColorExpression(`var(${pair.foreground})`, tokens);
      const background = resolveColorExpression(`var(${pair.background})`, tokens);
      const backdrop = pair.backdrop
        ? resolveColorExpression(`var(${pair.backdrop})`, tokens)
        : undefined;
      if (!foreground || !background || (pair.backdrop && !backdrop)) {
        findings.push({
          kind: "semantic",
          themeId,
          ...pair,
          error: `missing ${
            !foreground ? pair.foreground : !background ? pair.background : pair.backdrop
          }`,
        });
        continue;
      }
      const ratio = contrastRatio(foreground.color, background.color, backdrop?.color);
      if (ratio + Number.EPSILON < pair.minimum) {
        findings.push({
          kind: "semantic",
          themeId,
          ...pair,
          foregroundValue: foreground.value,
          backgroundValue: background.value,
          ratio,
        });
      }
    }

    for (const usage of discovery.usages) {
      const usageTokens = new Map(tokens);
      for (const [property, value] of usage.localTokens) usageTokens.set(property, value);
      const foreground = resolveColorExpression(usage.foreground, usageTokens);
      const background = resolveColorExpression(usage.background, usageTokens);
      const backdrop = resolveColorExpression("var(--app-canvas)", usageTokens);
      if (!foreground || !background || !backdrop) {
        const unresolved = !foreground ? "foreground" : !background ? "background" : "backdrop";
        findings.push({
          kind: "usage",
          themeId,
          ...usage,
          error: `unsupported ${unresolved} expression: ${
            unresolved === "foreground" ? usage.foreground
              : unresolved === "background" ? usage.background
                : "var(--app-canvas)"
          }`,
        });
        unsupportedUsages.add(`${usage.file}:${usage.line}:${usage.selector}`);
        continue;
      }
      const ratio = contrastRatio(foreground.color, background.color, backdrop.color);
      if (ratio + Number.EPSILON < usage.minimum) {
        findings.push({
          kind: "usage",
          themeId,
          ...usage,
          foreground: foreground.label,
          background: background.label,
          foregroundValue: foreground.value,
          backgroundValue: background.value,
          ratio,
        });
      }
    }

    for (const group of discovery.visualGroups ?? []) {
      if (group.error) {
        findings.push({
          kind: "visual",
          themeId,
          group: group.name,
          file: group.file,
          line: 1,
          selector: "<contract file>",
          error: group.error,
        });
        continue;
      }
      const resolvedEntries = [];
      for (const entry of group.entries) {
        if (entry.error) {
          findings.push({
            kind: "visual",
            themeId,
            group: group.name,
            ...entry,
          });
          continue;
        }
        const paint = resolveColorExpression(entry.paint, tokens);
        const backdrop = resolveColorExpression("var(--app-canvas)", tokens);
        if (!paint || !backdrop) {
          findings.push({
            kind: "visual",
            themeId,
            group: group.name,
            ...entry,
            error: `unsupported ${!paint ? "paint" : "backdrop"} expression: ${
              !paint ? entry.paint : "var(--app-canvas)"
            }`,
          });
          continue;
        }
        resolvedEntries.push({ ...entry, paint });
        for (const surfaceToken of group.surfaces) {
          const surface = resolveColorExpression(`var(${surfaceToken})`, tokens);
          if (!surface) {
            findings.push({
              kind: "visual",
              themeId,
              group: group.name,
              ...entry,
              error: `missing ${surfaceToken}`,
            });
            continue;
          }
          const ratio = contrastRatio(paint.color, surface.color, backdrop.color);
          if (ratio + Number.EPSILON < group.minimum) {
            findings.push({
              kind: "visual",
              themeId,
              group: group.name,
              ...entry,
              paintLabel: paint.label,
              surfaceLabel: surface.label,
              paintValue: paint.value,
              surfaceValue: surface.value,
              ratio,
              minimum: group.minimum,
            });
          }
        }
      }

      if (group.requireDistinct) {
        for (let firstIndex = 0; firstIndex < resolvedEntries.length; firstIndex += 1) {
          for (
            let secondIndex = firstIndex + 1;
            secondIndex < resolvedEntries.length;
            secondIndex += 1
          ) {
            const first = resolvedEntries[firstIndex];
            const second = resolvedEntries[secondIndex];
            if (first.paint.value !== second.paint.value) continue;
            findings.push({
              kind: "visual",
              themeId,
              group: group.name,
              file: first.file,
              line: first.line,
              selector: `${first.selector}, ${second.selector}`,
              error: `${first.label} and ${second.label} must resolve to distinct paints`
                + ` (both ${first.paint.value})`,
            });
          }
        }
      }
    }
  }
  return {
    findings,
    stats: {
      semanticPairs: CONTRAST_PAIRS.length,
      discoveredUsages: discovery.usages.length,
      directUsages: discovery.usages.filter(({ source }) => source !== "derived-state").length,
      derivedStateUsages: discovery.usages.filter(({ source }) => source === "derived-state").length,
      unsupportedUsages: unsupportedUsages.size,
      excludedNonFlatUsages: discovery.exclusions.length,
      cascadeExclusions: discovery.cascadeExclusions?.length ?? 0,
      visualStateGroups: discovery.visualGroups?.length ?? 0,
      visualStates: discovery.visualGroups
        ?.reduce((count, group) => count + group.entries.length, 0) ?? 0,
    },
  };
}

function printFinding(finding) {
  if (finding.kind === "visual") {
    const prefix = `${finding.themeId}: ${finding.group}:`
      + ` ${finding.file}:${finding.line} ${finding.selector}`;
    if (finding.error) return `${prefix}: ${finding.error}`;
    return `${prefix}: ${finding.paintLabel} on ${finding.surfaceLabel}`
      + ` is ${finding.paintValue} on ${finding.surfaceValue}`
      + ` (ratio ${finding.ratio.toFixed(2)}, requires ${finding.minimum.toFixed(2)})`;
  }
  if (finding.kind === "usage") {
    const prefix = `${finding.themeId}: ${finding.file}:${finding.line} ${finding.selector}`;
    if (finding.error) return `${prefix}: ${finding.error}`;
    return `${prefix}: ${finding.foreground} on ${finding.background}`
      + ` is ${finding.foregroundValue} on ${finding.backgroundValue}`
      + ` (ratio ${finding.ratio.toFixed(2)}, requires ${finding.minimum.toFixed(2)})`;
  }
  if (finding.error) return `${finding.themeId}: ${finding.error}`;
  return `${finding.themeId}: ${finding.foreground} on ${finding.background}`
    + ` is ${finding.foregroundValue} on ${finding.backgroundValue}`
    + ` (ratio ${finding.ratio.toFixed(2)}, requires ${finding.minimum.toFixed(2)})`;
}

function counted(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function discoverySummary(stats) {
  return `${counted(stats.discoveredUsages, "discovered rule-level usage")}`
    + ` (${counted(stats.directUsages, "direct rule-level usage")};`
    + ` ${counted(stats.derivedStateUsages, "derived state usage")}),`
    + ` ${counted(stats.unsupportedUsages, "unsupported usage", "unsupported")},`
    + ` ${counted(
      stats.excludedNonFlatUsages,
      "explicitly excluded non-flat/inherited usage",
    )},`
    + ` ${counted(stats.cascadeExclusions, "cascade exclusion")},`
    + ` ${counted(stats.visualStates, "visual-state paint")}`
    + ` across ${counted(stats.visualStateGroups, "contract group")}.`;
}

function main() {
  const args = process.argv.slice(2);
  const cssIndex = args.indexOf("--css");
  const sourceIndex = args.indexOf("--src");
  const cssPath = resolve(cssIndex >= 0 ? args[cssIndex + 1] : "src/theme/themes.css");
  const shouldDiscoverUsage = sourceIndex >= 0 || cssIndex < 0;
  const sourceRoot = resolve(sourceIndex >= 0 ? args[sourceIndex + 1] : "src");
  const discovery = shouldDiscoverUsage
    ? discoverCssContrastUsages(sourceRoot)
    : {
      usages: [],
      exclusions: [],
      cascadeExclusions: [],
      visualGroups: [],
    };
  const { findings, stats } = auditThemeContrast(readFileSync(cssPath, "utf8"), discovery);
  if (findings.length) {
    console.error("Theme contrast check failed:");
    for (const finding of findings) console.error(`  ${printFinding(finding)}`);
    console.error(
      `Audit summary: ${THEME_IDS.length} themes, ${stats.semanticPairs} semantic pairs,`
      + ` ${discoverySummary(stats)}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Theme contrast check passed: ${THEME_IDS.length} themes, ${stats.semanticPairs} semantic pairs,`
    + ` ${discoverySummary(stats)}`,
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main();
}
