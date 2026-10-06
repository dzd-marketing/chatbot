import { renderSkills } from "../types";
import { callSituations } from "./call-situations";
import { friendVoice } from "./friend-voice";
import { speakForTheEar } from "./speak-for-the-ear";

/** The speaking skills used in every voice call. */
export const voiceSkills = [friendVoice, speakForTheEar, callSituations];

/** The speaking skills as one block of the system prompt. */
export const renderVoiceSkills = () => renderSkills(voiceSkills);
