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

export function normalizeMathDelimiters(markdown: string): string {
  if (!(markdown.includes("\\") || markdown.includes("["))) {
    return markdown;
  }
  return markdown
    .split(CODE)
    .map((segment, index) => (index % 2 === 1 ? segment : convert(segment)))
    .join("");
}
