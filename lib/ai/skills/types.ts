/**
 * A skill: a focused set of instructions (with examples) added to the
 * system prompt when it applies, e.g. the speaking skills in a voice call.
 * Skills stay on the server like the rest of the system prompt.
 */
export type Skill = {
  /** Short id, also the heading the model sees. */
  name: string;
  /** When the skill applies (for people reading the code). */
  description: string;
  /** What the model is told. */
  instructions: string;
};

/** Skills as one block of the system prompt. */
export const renderSkills = (skills: readonly Skill[]) =>
  skills
    .map((skill) => `## Skill: ${skill.name}\n${skill.instructions.trim()}`)
    .join("\n\n");
