import { mml2omml } from "mathml2omml";
import katex from "@/lib/katex";

/**
 * TeX -> Word equation (OMML): KaTeX writes MathML, mathml2omml turns it
 * into Office Math. The result can be edited as a normal equation in Word.
 */

/**
 * mathml2omml writes <w:rPr> before <m:rPr>, can combine <m:nor/> with
 * <m:sty>, and writes m:val="undefined" for upright symbols (e.g. Δ, ∞).
 * Word's schema wants m:rPr first, only one of nor/sty, and p/b/i/bi.
 */
function fixRunProperties(omml: string) {
  return omml
    .replace(/<w:rPr\/>/g, "")
    .replace(/<m:sty m:val="undefined"\/>/g, '<m:sty m:val="p"/>')
    .replace(
      /(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)(<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)/g,
      "$2$1"
    )
    .replace(/<m:nor\/>(?=<m:sty\b)/g, "");
}

/**
 * mathml2omml doesn't know <mphantom> (invisible spacing, e.g. the
 * \vphantom{X} mhchem puts next to every subscript) or <mpadded>, and would
 * print the phantom's content. Phantoms are dropped, mpadded is unwrapped.
 */
function simplifyMathml(mathml: string) {
  let result = mathml;
  let previous = "";
  while (previous !== result) {
    previous = result;
    // innermost phantom first (no nested phantom inside the match)
    result = result.replace(
      /<mphantom\b[^>]*>(?:(?!<mphantom\b)[\s\S])*?<\/mphantom>/g,
      ""
    );
  }
  return result.replace(/<\/?mpadded\b[^>]*>/g, "");
}

/** OMML for the TeX (`<m:oMath>`, or `<m:oMathPara>` when displayed). */
export function texToOmml(tex: string, displayMode: boolean): string | null {
  try {
    const html = katex.renderToString(tex, {
      displayMode: false,
      output: "mathml",
      throwOnError: true,
    });
    const mathml = html
      .match(/<math[\s\S]*<\/math>/)?.[0]
      ?.replace(/<annotation[\s\S]*?<\/annotation>/g, "");
    if (!mathml) {
      return null;
    }
    const omml = fixRunProperties(mml2omml(simplifyMathml(mathml)));
    if (!omml.startsWith("<m:oMath") || omml.includes('"undefined"')) {
      return null;
    }
    return displayMode
      ? `<m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${omml}</m:oMathPara>`
      : omml;
  } catch {
    // Invalid TeX: the caller shows it as text.
    return null;
  }
}
