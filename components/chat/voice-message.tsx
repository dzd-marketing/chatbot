"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ReadAloud } from "@/components/ai-elements/read-aloud";
import type { VoiceData } from "@/lib/types";
import { spokenWordIndex } from "@/lib/voice-message";

const RATES = [1, 1.25, 1.5, 2] as const;
/** Only one voice message plays at a time. */
const PLAY_EVENT = "dzd-voice-message-play";

function formatTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * A student's voice message: the recording plays back while the word being
 * spoken lights up (assistant-ui's Read aloud element).
 */
export function VoiceMessage({
  url,
  data,
  className,
}: {
  url: string;
  data: VoiceData;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const rate = RATES[rateIndex] ?? 1;

  const words = data.words.map((word) => word.text);
  // Recordings from Chrome often report no duration, so the stored one wins.
  const duration = data.duration || mediaDuration;

  // Smooth word highlighting while playing.
  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        setTimeMs(audio.currentTime * 1000);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Pause when another voice message starts.
  useEffect(() => {
    const onOtherPlay = (event: Event) => {
      const audio = audioRef.current;
      if (audio && (event as CustomEvent).detail !== audio) {
        audio.pause();
      }
    };
    window.addEventListener(PLAY_EVENT, onOtherPlay);
    return () => window.removeEventListener(PLAY_EVENT, onOtherPlay);
  }, []);

  const handleToggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (ended) {
      audio.currentTime = 0;
      setTimeMs(0);
      setEnded(false);
    }
    audio.playbackRate = rate;
    window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: audio }));
    audio.play().catch(() => {
      toast.error("Couldn't play this voice message.");
    });
  }, [ended, rate]);

  const handleRateChange = useCallback(() => {
    setRateIndex((index) => {
      const next = (index + 1) % RATES.length;
      if (audioRef.current) {
        audioRef.current.playbackRate = RATES[next] ?? 1;
      }
      return next;
    });
  }, []);

  const handlePlay = useCallback(() => setPlaying(true), []);
  const handlePause = useCallback(() => setPlaying(false), []);
  const handleEnded = useCallback(() => {
    setPlaying(false);
    setEnded(true);
    setTimeMs(duration);
  }, [duration]);
  const handleMetadata = useCallback(() => {
    const value = audioRef.current?.duration;
    if (value && Number.isFinite(value)) {
      setMediaDuration(value * 1000);
    }
  }, []);
  const handleError = useCallback(() => {
    setPlaying(false);
  }, []);

  let spokenIndex = 0;
  if (ended) {
    spokenIndex = words.length;
  } else if (playing || timeMs > 0) {
    spokenIndex = spokenWordIndex(data, timeMs);
  }

  return (
    <>
      <ReadAloud
        className={className}
        data-testid="voice-message"
        duration={formatTime(duration)}
        elapsed={formatTime(Math.min(timeMs, duration || timeMs))}
        onRateChange={handleRateChange}
        onToggle={handleToggle}
        playing={playing}
        rate={rate}
        spokenIndex={spokenIndex}
        words={words}
      />
      {/* biome-ignore lint/a11y/useMediaCaption: the transcript is shown above */}
      <audio
        className="hidden"
        onEnded={handleEnded}
        onError={handleError}
        onLoadedMetadata={handleMetadata}
        onPause={handlePause}
        onPlay={handlePlay}
        preload="none"
        ref={audioRef}
        src={url}
      />
    </>
  );
}
