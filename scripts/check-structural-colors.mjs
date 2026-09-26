#!/usr/bin/env node
/** Enforce semantic theme tokens for every new source color literal. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ROOT = "src";
const DEFAULT_ALLOWLIST = "src/theme/color-literal-allowlist.json";
const COLOR_FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch",
  "color", "color-mix",
]);
const CONTROL_CONDITION_KEYWORDS = new Set([
  "if", "while", "for", "with", "switch", "catch",
]);
const INTERPOLATION_SENTINEL = "\uE000";
const NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
  "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood",
  "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
  "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen",
  "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
  "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue",
  "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey",
  "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
  "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue",
  "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
  "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
  "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle",
  "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow",
  "yellowgreen",
]);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function sourcePath(file) {
  return file.replaceAll("\\", "/");
}

export function isSourceFile(file) {
  const normalized = sourcePath(file);
  return /^src\/.*\.(?:css|tsx)$/.test(normalized)
    && !/\.test\.tsx?$/.test(normalized)
    && !(process.env.STRUCTURAL_COLOR_GUARD_IGNORE_TEST_FIXTURES === "1" && normalized.includes("/.color-guard-"))
    && normalized !== "src/theme/themes.css";
}

export function propertyFor(line) {
  return line.match(/^\s*([\w-]+)\s*:/)?.[1]
    ?? line.match(/\b(background(?:Color)?|color|border(?:\w+)?|outline|boxShadow|textShadow|fill|stroke)\s*:/)?.[1]
    ?? "unknown";
}

function isColorProperty(property) {
  const normalized = property.toLowerCase();
  return normalized === "color"
    || normalized === "fill"
    || normalized === "stroke"
    || normalized.startsWith("background")
    || normalized.startsWith("border")
    || normalized.startsWith("outline")
    || normalized === "boxshadow"
    || normalized === "box-shadow"
    || normalized === "textshadow"
    || normalized === "text-shadow"
    || normalized.endsWith("-color");
}

function readAllowlist(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.entries)) throw new Error(`${file} must contain an entries array`);
  return parsed.entries;
}

function allowed(finding, entries) {
  return entries.some((entry) => entry.path === finding.file
    && entry.value.toLowerCase() === finding.value
    && entry.property === finding.property
    && entry.context
    && finding.source.includes(entry.context)
    && entry.role);
}

export function findingsForText(file, text, entries = []) {
  const normalizedFile = sourcePath(file);
  if (!isSourceFile(normalizedFile)) return [];
  const findings = [];
  const semanticText = maskComments(text, !file.endsWith(".css"));
  const groups = [{
    scanText: semanticText,
    displayText: text,
    offset: 0,
    css: file.endsWith(".css"),
    interpolations: [],
  }];
  if (!file.endsWith(".css")) {
    for (const range of cssBearingRanges(semanticText)) {
      const displayText = text.slice(range.contentStart, range.contentEnd);
      let scanText = semanticText.slice(range.contentStart, range.contentEnd);
      const interpolations = range.template ? templateInterpolationRanges(displayText) : [];
      if (range.template) scanText = maskTemplateInterpolations(scanText, interpolations);
      groups.push({
        scanText: maskComments(scanText, false),
        displayText,
        offset: range.contentStart,
        css: true,
        interpolations,
      });
    }
  }
  for (const group of groups) {
    for (const declaration of declarationsIn(group.scanText, group.css)) {
      const scanValue = group.scanText.slice(declaration.valueStart, declaration.valueEnd);
      const displayValue = group.displayText.slice(declaration.valueStart, declaration.valueEnd);
      const matches = [
        ...literalColorsIn(scanValue, displayValue),
        ...interpolationLiteralColorsIn(group.displayText, declaration, group.interpolations),
      ];
      for (const match of matches) {
        const absoluteOffset = group.offset + declaration.valueStart + match.reportOffset;
        const absoluteProperty = group.offset + declaration.propertyStart;
        const absoluteValueEnd = group.offset + declaration.valueEnd;
        const line = lineAt(text, absoluteOffset);
        const source = contextFor(text, absoluteProperty, absoluteValueEnd);
        const finding = {
          file: normalizedFile,
          line,
          value: match.value.toLowerCase().replace(/\s+/g, " ").trim(),
          property: declaration.property,
          source,
        };
        if (!allowed(finding, entries)) findings.push(finding);
      }
    }
  }
  return [...new Map(findings.map((finding) => [
    `${finding.line}:${finding.property}:${finding.value}`,
    finding,
  ])).values()];
}

/** Replace comments with spaces while preserving every character offset/newline. */
function maskComments(text, lineComments = true) {
  const output = text.split("");
  const parentheses = [];
  const controlConditionClosers = new Set();
  let quote = "";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "`") {
      index = templateLiteralEnd(text, index);
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
          output[index] = " ";
          output[index + 1] = " ";
          index += 1;
          break;
        }
        if (text[index] !== "\n") output[index] = " ";
        index += 1;
      }
      continue;
    }
    if (lineComments && char === "/" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        output[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (lineComments && char === "/" && canStartRegex(output, index, controlConditionClosers)) {
      const end = regexEnd(text, index);
      if (end > index) {
        for (let offset = index; offset <= end; offset += 1) {
          if (output[offset] !== "\n") output[offset] = " ";
        }
        index = end;
        continue;
      }
    }
    if (char === "(") {
      parentheses.push(controlKeywordBefore(output, index));
    } else if (char === ")") {
      if (parentheses.pop()) controlConditionClosers.add(index);
    }
  }
  return output.join("");
}

function canStartRegex(text, slash, controlConditionClosers = new Set()) {
  let previous = slash - 1;
  while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
  if (previous < 0) return true;
  if ("([{:;,=!?&|+-*%^~<>".includes(text[previous])) return true;
  if (text[previous] === ")" && controlConditionClosers.has(previous)) return true;
  if (!/[A-Za-z0-9_$]/.test(text[previous])) return false;
  let start = previous;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start -= 1;
  const tokenSlice = text.slice(start + 1, previous + 1);
  const token = Array.isArray(tokenSlice) ? tokenSlice.join("") : tokenSlice;
  return new Set([
    "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of",
    "return", "throw", "typeof", "void", "yield",
  ]).has(token);
}

function controlKeywordBefore(text, open) {
  let previous = open - 1;
  while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
  const end = previous + 1;
  while (previous >= 0 && /[A-Za-z0-9_$]/.test(text[previous])) previous -= 1;
  const wordSlice = text.slice(previous + 1, end);
  const word = Array.isArray(wordSlice) ? wordSlice.join("") : wordSlice;
  let boundary = previous;
  while (boundary >= 0 && /\s/.test(text[boundary])) boundary -= 1;
  if (text[boundary] === ".") return false;
  if (CONTROL_CONDITION_KEYWORDS.has(word)) return true;
  return word === "await" && wordBefore(text, previous + 1) === "for";
}

function wordBefore(text, before) {
  let previous = before - 1;
  while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
  const end = previous + 1;
  while (previous >= 0 && /[A-Za-z0-9_$]/.test(text[previous])) previous -= 1;
  const slice = text.slice(previous + 1, end);
  return Array.isArray(slice) ? slice.join("") : slice;
}

function regexEnd(text, open) {
  let escaped = false;
  let characterClass = false;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") return -1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") characterClass = true;
    else if (char === "]" && characterClass) characterClass = false;
    else if (char === "/" && !characterClass) {
      while (/[A-Za-z]/.test(text[index + 1] ?? "")) index += 1;
      return index;
    }
  }
  return -1;
}

function cssBearingRanges(text) {
  const ranges = [];
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      index = quotedEnd(text, index) + 1;
      continue;
    }
    if (!/[A-Za-z_$]/.test(char)
      || (index > 0 && /[A-Za-z0-9_$]/.test(text[index - 1]))) {
      index += 1;
      continue;
    }
    const name = text.slice(index).match(/^[A-Za-z_$][\w$]*/)?.[0] ?? "";
    if (name === "cssText") {
      let previous = index - 1;
      while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
      let cursor = skipWhitespace(text, index + name.length);
      if (text[previous] === "." && text[cursor] === "=" && text[cursor + 1] !== "=") {
        cursor = skipWhitespace(text, cursor + 1);
        const range = quotedContentRange(text, cursor);
        if (range) {
          ranges.push(range);
          index = range.contentEnd + 1;
          continue;
        }
      }
    } else if (name === "setAttribute") {
      let cursor = skipWhitespace(text, index + name.length);
      if (text[cursor] === "(") {
        cursor = skipWhitespace(text, cursor + 1);
        const attribute = quotedContentRange(text, cursor);
        if (attribute
          && text.slice(attribute.contentStart, attribute.contentEnd).toLowerCase() === "style") {
          cursor = skipWhitespace(text, attribute.contentEnd + 1);
          if (text[cursor] === ",") {
            cursor = skipWhitespace(text, cursor + 1);
            const range = quotedContentRange(text, cursor);
            if (range) {
              ranges.push(range);
              index = range.contentEnd + 1;
              continue;
            }
          }
        }
      }
    }
    index += Math.max(name.length, 1);
  }
  return ranges;
}

function skipWhitespace(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? "")) index += 1;
  return index;
}

function quotedContentRange(text, quote) {
  if (!"'\"`".includes(text[quote] ?? "")) return null;
  return {
    contentStart: quote + 1,
    contentEnd: quotedEnd(text, quote),
    template: text[quote] === "`",
  };
}

function templateInterpolationRanges(text) {
  const ranges = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== "$" || text[index + 1] !== "{" || isEscaped(text, index)) continue;
    const end = matchingBraceEnd(text, index + 1);
    ranges.push({
      start: index,
      end,
      expressionStart: index + 2,
      expressionEnd: end,
    });
    index = end;
  }
  return ranges;
}

function maskTemplateInterpolations(text, ranges = templateInterpolationRanges(text)) {
  const output = text.split("");
  for (const range of ranges) {
    output[range.start] = INTERPOLATION_SENTINEL;
    for (let offset = range.start + 1; offset <= range.end; offset += 1) {
      if (output[offset] !== "\n") output[offset] = " ";
    }
  }
  return output.join("");
}

function interpolationLiteralColorsIn(text, declaration, interpolations) {
  const matches = [];
  for (const interpolation of interpolations) {
    if (interpolation.start < declaration.valueStart
      || interpolation.end > declaration.valueEnd) continue;
    for (const literal of literalStringColorsInExpression(
      text,
      interpolation.expressionStart,
      interpolation.expressionEnd,
    )) {
      matches.push({
        value: literal.value,
        reportOffset: literal.offset - declaration.valueStart,
      });
    }
  }
  return matches;
}

function literalStringColorsInExpression(text, start, end) {
  const expression = text.slice(start, end);
  const semantic = maskComments(expression, true);
  const matches = [];
  for (let index = 0; index < semantic.length;) {
    const quote = semantic[index];
    if (quote !== "'" && quote !== '"' && quote !== "`") {
      index += 1;
      continue;
    }
    const close = quotedEnd(semantic, index);
    const contentStart = index + 1;
    const contentEnd = Math.min(close, semantic.length);
    if (quote === "`") {
      const nested = templateInterpolationRanges(expression.slice(contentStart, contentEnd));
      if (nested.length === 0) {
        const literal = exactColorLiteral(expression.slice(contentStart, contentEnd));
        if (literal) {
          matches.push({
            value: literal.value,
            offset: start + contentStart + literal.offset,
          });
        }
      } else {
        for (const interpolation of nested) {
          matches.push(...literalStringColorsInExpression(
            expression,
            contentStart + interpolation.expressionStart,
            contentStart + interpolation.expressionEnd,
          ).map((match) => ({
            value: match.value,
            offset: start + match.offset,
          })));
        }
      }
    } else {
      const literal = exactColorLiteral(expression.slice(contentStart, contentEnd));
      if (literal) {
        matches.push({
          value: literal.value,
          offset: start + contentStart + literal.offset,
        });
      }
    }
    index = Math.max(close + 1, index + 1);
  }
  return matches;
}

function exactColorLiteral(content) {
  const leading = content.search(/\S/);
  if (leading < 0) return null;
  const value = content.trim();
  const matches = literalColorsIn(value);
  if (!matches.some((match) => match.value === value)) return null;
  return { value, offset: leading };
}

function matchingBraceEnd(text, open) {
  let depth = 1;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      index = quotedEnd(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) return text.length - 1;
      index = end + 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index + 2);
      if (end < 0) return text.length - 1;
      index = end;
      continue;
    }
    if (char === "/" && canStartRegex(text, index)) {
      const end = regexEnd(text, index);
      if (end > index) {
        index = end;
        continue;
      }
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return text.length - 1;
}

function declarationsIn(text, css) {
  const declarations = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      const end = quotedEnd(text, index);
      const name = text.slice(index + 1, end);
      let cursor = end + 1;
      while (/\s/.test(text[cursor] ?? "")) cursor += 1;
      let previous = index - 1;
      while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
      if (!css && isColorProperty(name) && text[cursor] === ":"
        && (previous < 0 || "{;,".includes(text[previous]))) {
        const valueStart = cursor + 1;
        const valueEnd = declarationEnd(text, valueStart, false);
        declarations.push({ property: name, propertyStart: index, valueStart, valueEnd });
        index = Math.max(valueEnd - 1, index);
      } else {
        index = end;
      }
      continue;
    }
    if (!/[\w-]/.test(char) || (index > 0 && /[\w-]/.test(text[index - 1]))) continue;
    const name = text.slice(index).match(/^[\w-]+/)?.[0] ?? "";
    if (!isColorProperty(name)) {
      index += Math.max(name.length - 1, 0);
      continue;
    }
    let cursor = index + name.length;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== ":") {
      index += name.length - 1;
      continue;
    }
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
    if (previous >= 0 && !"{;,".includes(text[previous])) {
      index += name.length - 1;
      continue;
    }
    const valueStart = cursor + 1;
    const valueEnd = declarationEnd(text, valueStart, css);
    declarations.push({ property: name, propertyStart: index, valueStart, valueEnd });
    index = Math.max(valueEnd - 1, index);
  }
  return declarations;
}

function quotedEnd(text, open) {
  const quote = text[open];
  if (quote === "`") return templateLiteralEnd(text, open);
  let escaped = false;
  for (let index = open + 1; index < text.length; index += 1) {
    if (escaped) escaped = false;
    else if (text[index] === "\\") escaped = true;
    else if (text[index] === quote) return index;
  }
  return text.length - 1;
}

function templateLiteralEnd(text, open) {
  let escaped = false;
  for (let index = open + 1; index < text.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (text[index] === "\\") {
      escaped = true;
      continue;
    }
    if (text[index] === "`") return index;
    if (text[index] === "$" && text[index + 1] === "{") {
      index = matchingBraceEnd(text, index + 1);
    }
  }
  return text.length - 1;
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let offset = index - 1; offset >= 0 && text[offset] === "\\"; offset -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function declarationEnd(text, start, css) {
  let quote = "";
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let escapedOutside = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (escapedOutside) {
      escapedOutside = false;
      continue;
    }
    if (char === "\\") {
      escapedOutside = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(parentheses - 1, 0);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(brackets - 1, 0);
    else if (char === "{") braces += 1;
    else if (char === "}") {
      if (braces === 0 && parentheses === 0 && brackets === 0) return index;
      braces = Math.max(braces - 1, 0);
    } else if (parentheses === 0 && brackets === 0 && braces === 0
      && (char === ";" || (!css && char === ","))) {
      return index;
    }
  }
  return text.length;
}

function literalColorsIn(value, displayValue = value) {
  const text = maskFunctions(value, new Set(["url"]));
  const matches = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === "#") {
      const hex = text.slice(index).match(/^#[0-9a-fA-F]{3,8}\b/)?.[0];
      if (hex) {
        matches.push({ value: displayValue.slice(index, index + hex.length), reportOffset: index });
        index += hex.length;
        continue;
      }
    }
    if (/[a-zA-Z]/.test(text[index])) {
      const word = text.slice(index).match(/^[a-zA-Z-]+/)?.[0] ?? "";
      const normalized = word.toLowerCase();
      let cursor = index + word.length;
      while (/\s/.test(text[cursor] ?? "")) cursor += 1;
      if ((normalized === "var" || normalized === "env") && text[cursor] === "(") {
        index = balancedFunctionEnd(text, cursor) + 1;
        continue;
      }
      if (COLOR_FUNCTIONS.has(normalized) && text[cursor] === "(") {
        const end = balancedFunctionEnd(text, cursor);
        const functionValue = displayValue.slice(index, end + 1);
        const innerStart = cursor + 1;
        const inner = value.slice(innerStart, end);
        const displayInner = displayValue.slice(innerStart, end);
        const nested = literalColorsIn(inner, displayInner);
        const containsVariable = /\b(?:var|env)\s*\(/i.test(inner)
          || inner.includes(INTERPOLATION_SENTINEL);
        if (normalized === "color-mix") {
          if (nested.length) {
            matches.push({
              value: functionValue,
              reportOffset: innerStart + nested[0].reportOffset,
            });
          }
        } else if (!containsVariable || nested.length) {
          const numericOffset = inner.search(/[-+]?(?:\d*\.)?\d+(?:%|deg|grad|rad|turn)?\b/i);
          matches.push({
            value: functionValue,
            reportOffset: nested.length
              ? innerStart + nested[0].reportOffset
              : numericOffset >= 0
                ? innerStart + numericOffset
                : index,
          });
        }
        index = end + 1;
        continue;
      }
      const previous = text[index - 1] ?? "";
      const next = text[index + word.length] ?? "";
      if (NAMED_COLORS.has(normalized)
        && !/[-.\w]/.test(previous)
        && !/[-\w]/.test(next)) {
        matches.push({
          value: displayValue.slice(index, index + word.length),
          reportOffset: index,
        });
      }
      index += Math.max(word.length, 1);
      continue;
    }
    index += 1;
  }
  return matches;
}

function balancedFunctionEnd(text, open) {
  let depth = 1;
  let quote = "";
  let escaped = false;
  let escapedOutside = false;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (escapedOutside) {
      escapedOutside = false;
      continue;
    }
    if (char === "\\") {
      escapedOutside = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return text.length - 1;
}

function maskFunctions(text, names) {
  const output = text.split("");
  for (let index = 0; index < text.length;) {
    if (!/[a-zA-Z]/.test(text[index])) {
      index += 1;
      continue;
    }
    const word = text.slice(index).match(/^[a-zA-Z-]+/)?.[0] ?? "";
    let cursor = index + word.length;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (names.has(word.toLowerCase()) && text[cursor] === "(") {
      const end = balancedFunctionEnd(text, cursor);
      for (let offset = index; offset <= end; offset += 1) {
        if (output[offset] !== "\n") output[offset] = " ";
      }
      index = end + 1;
    } else {
      index += Math.max(word.length, 1);
    }
  }
  return output.join("");
}

function lineAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function contextFor(text, propertyStart, valueEnd) {
  const lineStart = text.lastIndexOf("\n", propertyStart - 1) + 1;
  const lineEnd = text.indexOf("\n", valueEnd);
  return text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
}

export function resolveBase(requested) {
  const explicitWasInvalid = !!requested
    && (/^0{40}$/.test(requested) || !canResolve(requested));
  const candidates = [
    ...(!explicitWasInvalid && requested ? [requested] : []),
    process.env.STRUCTURAL_COLOR_BASE,
    "origin/main",
    "main",
    "HEAD~1",
  ].filter((candidate, index, all) => candidate && !/^0{40}$/.test(candidate)
    && all.indexOf(candidate) === index);
  for (const candidate of candidates) {
    try {
      const base = git(["merge-base", candidate, "HEAD"]);
      if (explicitWasInvalid && base === git(["rev-parse", "HEAD"]) && candidate !== "HEAD~1") {
        continue;
      }
      return base;
    } catch {
      // A shallow/local checkout may not have origin/main. Try the next base.
    }
  }
  throw new Error("Unable to resolve a structural-color base; pass --base <revision>.");
}

function canResolve(revision) {
  try {
    git(["rev-parse", "--verify", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function changedTrackedLines(base, entries) {
  const diff = git(["diff", "--no-ext-diff", "--unified=0", base, "--", SOURCE_ROOT]);
  const addedLines = new Map();
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6);
      if (!addedLines.has(file)) addedLines.set(file, new Set());
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      addedLines.get(file)?.add(line);
      line += 1;
    } else if (!raw.startsWith("-")) line += 1;
  }
  return [...addedLines.entries()].flatMap(([changedFile, lines]) => {
    if (!existsSync(changedFile) || !isSourceFile(changedFile)) return [];
    return findingsForText(changedFile, readFileSync(changedFile, "utf8"), entries)
      .filter((finding) => lines.has(finding.line));
  });
}

function untrackedFiles(entries) {
  const findings = [];
  for (const file of git(["ls-files", "--others", "--exclude-standard", "--", SOURCE_ROOT]).split("\n")) {
    if (file && isSourceFile(file)) findings.push(...findingsForText(file, readFileSync(file, "utf8"), entries));
  }
  return findings;
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(file, files);
    else if (isSourceFile(file)) files.push(file);
  }
  return files;
}

export function inventory(entries = []) {
  return walk(SOURCE_ROOT).flatMap((file) => findingsForText(file, readFileSync(file, "utf8"), entries));
}

function printFindings(findings) {
  console.error("Literal colors must be semantic tokens or an exact domain allowlist entry:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} ${finding.value} property=${finding.property}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const allowlistFile = get("--allowlist") ?? DEFAULT_ALLOWLIST;
  const entries = readAllowlist(allowlistFile);
  const checkFile = args.indexOf("--check-file");
  const findings = checkFile >= 0
    ? findingsForText(relative(process.cwd(), resolve(args[checkFile + 1])), readFileSync(args[checkFile + 1], "utf8"), entries)
    : args.includes("--inventory")
      ? inventory(entries)
      : [...changedTrackedLines(resolveBase(get("--base")), entries), ...untrackedFiles(entries)];
  if (findings.length) {
    printFindings(findings);
    process.exitCode = 1;
  } else {
    console.log(args.includes("--inventory") ? "Structural color inventory passed." : "Structural color guard passed.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
