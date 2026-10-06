import { renderSkills } from "../types";
import { callSituations } from "./call-situations";
import { friendVoice } from "./friend-voice";
import { voiceGuardrails } from "./guardrails";
import { speakForTheEar } from "./speak-for-the-ear";
import { turnTaking } from "./turn-taking";
import { voiceTutor } from "./voice-tutor";

/**
 * The speaking skills used in every voice call, in the order the model
 * reads them. Based on voice-assistant design guides (OpenAI Realtime
 * prompting, ElevenLabs Agents, Google conversation design, Alexa design
 * guide, Vapi) and Google's LearnLM learning-science principles.
 */
export const voiceSkills = [
  friendVoice,
  speakForTheEar,
  turnTaking,
  voiceTutor,
  callSituations,
  voiceGuardrails,
];

/** The speaking skills as one block of the system prompt. */
export const renderVoiceSkills = () => renderSkills(voiceSkills);
