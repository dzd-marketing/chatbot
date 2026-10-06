/**
 * Many models write LaTeX with \( … \) and \[ … \] delimiters, which the
 * Markdown renderer doesn't understand (Markdown even turns "\[" into a
 * plain "["). This converts them to $ … $ and $$ … $$, which are rendered
 * with KaTeX. Code blocks and inline code are left untouched.
 */

/** Fenced code blocks (also unfinished ones while streaming) and `code`. */
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/g;

/** \[ … \] (display), not preceded by another backslash (a LaTeX "\\"). */
const DISPLAY = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g;
/** \( … \) (inline). */
const INLINE = /(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g;
/**
 * A whole line wrapped in [ … ] that contains LaTeX commands: a display
 * equation whose backslashes were lost, e.g. "[ 72\ \frac{km}{h} = 20 ]".
 */
const BARE_DISPLAY_LINE =
  /^([ \t]*)\[[ \t]*(.*\\[a-zA-Z]+.*?)[ \t]*\][ \t]*$/gm;

function convert(text: string) {
  return text
    .replace(DISPLAY, (_, inner: string) => `\n$$\n${inner.trim()}\n$$\n`)
    .replace(INLINE, (_, inner: string) => `$${inner.trim()}$`)
    .replace(BARE_DISPLAY_LINE, (match, indent: string, inner: string) =>
      // Not a Markdown link or checkbox.
      /\]\(|^\s*[xX ]?\s*$/.test(inner)
        ? match
        : `${indent}$$\n${indent}${inner.trim()}\n${indent}$$`
    );
}

/** Maths already in $ … $ or $$ … $$ (left as is). */
const MATH = /(\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+?(?<!\\)\$)/g;
const CHEM_COMMAND = /\\(?:ce|pu)\{/g;

/**
 * Wraps chemistry written outside maths, e.g. "Water is \ce{H2O}." ->
 * "Water is $\ce{H2O}$.", matching nested braces. An unfinished command
 * (still streaming) is left alone.
 */
function wrapBareChemistry(text: string) {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(CHEM_COMMAND)) {
    const start = match.index ?? 0;
    if (start < last) {
      continue;
    }
    let depth = 0;
    let end = -1;
    for (
      let index = start + match[0].length - 1;
      index < text.length;
      index += 1
    ) {
      if (text[index] === "{") {
        depth += 1;
      } else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) {
      break;
    }
    result += `${text.slice(last, start)}$${text.slice(start, end)}$`;
    last = end;
  }
  return result + text.slice(last);
}

function convertWithChemistry(text: string) {
  const converted = convert(text);
  if (!(converted.includes("\\ce{") || converted.includes("\\pu{"))) {
    return converted;
  }
  return converted
    .split(MATH)
    .map((part, index) => (index % 2 === 1 ? part : wrapBareChemistry(part)))
    .join("");
}

export function normalizeMathDelimiters(markdown: string): string {
  if (!(markdown.includes("\\") || markdown.includes("["))) {
    return markdown;
  }
  return markdown
    .split(CODE)
    .map((segment, index) =>
      index % 2 === 1 ? segment : convertWithChemistry(segment)
    )
    .join("");
}
