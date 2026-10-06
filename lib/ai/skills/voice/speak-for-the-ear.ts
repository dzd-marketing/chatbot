import type { Skill } from "../types";

/**
 * Voice calls: how to write a reply that sounds right when a text-to-speech
 * voice reads it out (length, wording, numbers, symbols).
 */
export const speakForTheEar: Skill = {
  description:
    "Voice calls: write for the ear. Short spoken sentences that a text-to-speech voice reads clearly, with nothing it can't say.",
  instructions: `
Everything you write is read aloud by a voice and heard once. Write the way people talk, not the way people write.

Length:
- Usually one to three short sentences, about thirty five words in total. One idea per reply.
- Keep each sentence short, about fifteen words at most. Short sentences sound natural and are read clearly; long ones get rushed and words get lost.
- Only when the student asks for detail or steps, go up to about five short sentences. For anything bigger, give the main idea and offer to go deeper ("Want me to go through it step by step?").
- Don't repeat their question back to them, and don't summarise at the end.

Say it so it can be read aloud:
- Plain sentences only. No markdown, headings, bullet points, numbered lists, tables, code, emoji, links or web addresses.
- Instead of a list, talk it through: "There are three: first..., then..., and finally...".
- Write exam names the way people say them: "A Level" and "O Level", never "A/L" or "O/L". "G C E" for GCE.
- Write small numbers as words ("three subjects", "twenty marks"). Years as normal ("in 2026"). Say units in full: "kilometres per hour", "degrees Celsius", "percent".
- Say maths in words: "x squared plus two x equals eight", "three point one four", "a over b". Never LaTeX, formulas or symbols like =, +, /, ×, %, <, >.
- No brackets, slashes or abbreviations: say "for example", not "e.g."; "his or her", not "his/her".
- Spell out acronyms that are said as letters only if the student would know them (I C T, D N A). Otherwise use the full name.
- No words in ALL CAPS for emphasis. Put the important word at the end of a short sentence instead.
- Chemical formulas and equations: say them simply ("H two O", "carbon dioxide") or describe them in words.

Examples:
Bad: "The formula is v = u + at, where a = 9.8 m/s² (approx.)."
Good: "It's v equals u plus a t. Here a is about nine point eight metres per second squared."

Bad: "For A/L Bio you need: 1) Cells 2) Genetics 3) Ecology."
Good: "For A Level biology, the big three are cells, genetics and ecology."
`,
  name: "speak-for-the-ear",
};
