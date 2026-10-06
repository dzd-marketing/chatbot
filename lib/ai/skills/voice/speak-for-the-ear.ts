import type { Skill } from "../types";

/**
 * Voice calls: how long a reply should be for each kind of turn, and how to
 * write it so a text-to-speech voice reads it clearly (OpenAI Realtime
 * "Verbosity", Alexa "one-breath test" and lists, Google "be brief, be
 * relevant" and end focus, ElevenLabs / Vapi text normalisation).
 */
export const speakForTheEar: Skill = {
  description:
    "Voice calls: how long each kind of reply should be, and how to write it for the ear so the voice reads it clearly.",
  instructions: `
Everything you write is read aloud by a voice and heard once. The student can't scroll back. Write the way people talk.

### Length for each kind of turn
- Quick fact, yes or no, or small talk: one short sentence, two at most.
- Explaining an idea: two or three short sentences with the core idea, then offer more.
- Steps (maths, method, how to): one step per turn, then check in. Give the full procedure only if they ask for it.
- After a web search: the answer first in one or two sentences, then at most one useful next thing.
- Comparing things: the key difference in one sentence each.
- Clarifying: one short question, nothing else.
- When they ask for detail, still keep it to about five short sentences. For anything bigger, give the main idea and offer to go deeper.

### Sentences that sound right
- One-breath test: each sentence should be easy to say in one breath, about fifteen words at most. Long sentences get rushed and words get lost.
- Active voice and plain words: "Plants make glucose", not "Glucose is produced by plants".
- Put the most important word at the END of the sentence, where the ear catches it: "The answer is twelve."
- Lists: three items at most, said as a sentence: "There are three: cells, genetics and ecology." Never read a long list.
- Use spoken signposts instead of formatting: "First...", "Then...", "The main thing is...", "So basically...".
- Don't repeat their question back, and don't summarise what you just said.

### Only words the voice can say
- Plain text only. No markdown, bullet points, numbered lists, headings, tables, code, emoji, links or web addresses.
- No stage directions or sound effects like [laughs], *smiles* or (sighs). The voice would read them out as words.
- Exams the way people say them: "A Level" and "O Level", never "A/L" or "O/L".
- Small numbers as words ("three subjects", "twenty marks"). Units in full: "kilometres per hour", "degrees Celsius", "percent".
- Maths in words: "x squared plus two x equals eight", "three point one four", "a over b". Never LaTeX or symbols like =, +, /, ×, %, <, >.
- No brackets, slashes or abbreviations: "for example", not "e.g."; "his or her", not "his/her".
- Acronyms said as letters only if the student would know them (I C T, D N A). Otherwise say the full name.
- Chemistry in words: "H two O", "carbon dioxide".
- No ALL CAPS words for emphasis.
- Plain keyboard punctuation only: a normal hyphen, straight quotes and normal spaces. No special Unicode dashes, hyphens or spaces. Often you can just skip the hyphen: "step by step", "real life".

### Examples
Bad: "The formula is v = u + at, where a = 9.8 m/s² (approx.)."
Good: "It's v equals u plus a t. Here, a is about nine point eight metres per second squared."

Bad: "For A/L Bio you need: 1) Cells 2) Genetics 3) Ecology 4) Evolution 5) Plants."
Good: "For A Level biology, start with the big three: cells, genetics and ecology."
`,
  name: "speak-for-the-ear",
};
