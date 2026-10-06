/**
 * How much thought a spoken question needs in a voice call.
 * - "quick": facts, definitions, yes/no, small talk. A short, fast answer.
 * - "deep": planning, advice, decisions, "why" questions, problem solving,
 *   feelings, essays, long questions and "tell me more". The model thinks
 *   first and gives a fuller spoken answer (plus an optional written part
 *   for the chat), and the call allows a longer spoken reply.
 * Used by the call (spoken length, "let me think" line) and sent to the
 * server (reasoning, reply shape).
 */

export type VoiceDepth = "quick" | "deep";

/** Questions that need a thought-through answer, by situation. */
const DEEP_PATTERNS: readonly RegExp[] = [
  // Planning: timetables, schedules, study plans, "5 months left".
  /\b(time ?tables?|schedules?|study plans?|plans?|planning|routines?|road ?maps?|prepar(e|ing|ation)|revision)\b/i,
  /\bhow (should|do|can|to) (i |we )?(study|revise|learn|start|begin|prepare)\b/i,
  /\bwhere (do|should|can) i (start|begin)\b/i,
  /\b\d+\s*(months?|weeks?|days?)\b.*\b(left|to go|until|till|before|exam)/i,
  /\b(exams?|tests?|papers?)\b.*\bin\s+(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(months?|weeks?|days?)\b/i,
  // Advice and best practices.
  /\b(tips?|best practices?|advice|advise|suggestions?|suggest|strateg(y|ies)|techniques?|methods?|guidance|recommend\w*)\b/i,
  /\bhow (can|do|should|could) i (improve|get better|score|get an? |remember|memori[sz]e|focus|concentrate|stop|manage|balance|deal|cope|pass|motivate|beat|avoid|overcome|handle)\b/i,
  /\bwhat (should|can|do) i do\b/i,
  /\bhelp me (decide|choose|pick|plan|understand|figure|organi[sz]e|with)\b/i,
  // Decisions and comparisons.
  /\bshould i\b/i,
  /\bwhich (is|one|subject|stream|course|degree|university|uni|career|job|book|method|way)\b/i,
  /\b(pros and cons|advantages|disadvantages|compare|comparison|difference between|differences|better than|worth it|versus)\b/i,
  // Understanding: why / how it works / explain.
  /\bwhy\b/i,
  /\bhow (does|do|did|is|are|can)\b.*\b(work|happen|form|made|affect|cause|differ)/i,
  /\b(explain|elaborate|in detail|detailed|describe|what happens (when|if)|reason)\b/i,
  // Problem solving.
  /\b(solve|calculate|work out|find the value|prove|derive|derivation|show that|simplify|integrate|differentiate)\b/i,
  /\d\s*[-+*/×÷^=]\s*\d|[a-z]\s*=\s*\d/i,
  // Feelings and personal problems.
  /\b(stress(ed)?|anxious|anxiety|depress\w*|failed|fail(ing)?|can'?t focus|cannot focus|unmotivated|motivation|procrastinat\w*|give up|overwhelm\w*|scared|afraid|worried|pressure|lonely|burn(ed|t)? out|tired of)\b/i,
  // Writing and exam technique.
  /\b(essays?|structure|outline|model answer|how (do|should|to) (i )?answer|marks? questions?|exam technique|time management)\b/i,
  // "Tell me more" and other requests to go deeper.
  /\b(tell me more|more (detail|details|info)|go on|continue|keep going|go deeper|explain more|step by step|full (plan|answer|explanation)|the rest)\b/i,
  // Sinhala: timetable, plan, why, advice, methods, details, explain,
  // better, stress, scared, how to study.
  /කාල\s?සටහන|සැලැස්ම|සැලසුම|ඇයි|උපදෙස්|ක්‍රම|විස්තර|පැහැදිලි කර|වඩා හොඳ|ආතතිය|බයයි|පාඩම් කරන්නේ කොහොමද/,
  // Tamil: timetable, plan, why, advice, tips, explain, in detail, best,
  // stress, fear, how to study.
  /அட்டவணை|திட்டம்|ஏன்|ஆலோசனை|குறிப்புகள்|விளக்க|விரிவாக|சிறந்த|மன அழுத்த|பயம்|எப்படி படிக்க/,
];

/** Small talk and quick checks stay quick even with a "deep" word. */
const QUICK_PATTERNS: readonly RegExp[] = [
  /^(hi|hey|hello|yo|thanks|thank you|thx|ok(ay)?|cool|nice|bye|good ?bye|see you)\b[\s!.?]*$/i,
  /\bhow are you\b/i,
  /^(what('?s| is) (the )?(meaning|definition) of)\b/i,
];

/** Short replies that carry on the previous turn ("yes", "go ahead"). */
const FOLLOW_ON =
  /^(yes|yeah|yep|ya|sure|ok(ay)?|please|go ahead|do it|let'?s do it|alright|sounds good|හරි|ඔව්|ஆமா|சரி)\b/i;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * The depth for a spoken question. `previous` is the depth of the
 * student's last question, so "yes, go ahead" after a plan stays deep.
 */
export function voiceDepth(text: string, previous?: VoiceDepth): VoiceDepth {
  const said = text.trim();
  if (!said) {
    return "quick";
  }
  if (QUICK_PATTERNS.some((pattern) => pattern.test(said))) {
    return "quick";
  }
  const words = wordCount(said);
  if (previous === "deep" && words <= 6 && FOLLOW_ON.test(said)) {
    return "deep";
  }
  // Long or multi-part questions need a considered answer.
  if (words >= 25 || (said.match(/\?/g)?.length ?? 0) >= 2) {
    return "deep";
  }
  return DEEP_PATTERNS.some((pattern) => pattern.test(said)) ? "deep" : "quick";
}
