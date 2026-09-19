import { useEffect, useRef, useState } from 'react';

interface UseTypewriterOptions {
  /** When false, the full text is shown immediately. */
  active: boolean;
  /** Target animation duration in ms (clamped internally). */
  durationMs?: number;
  onComplete?: () => void;
  /** Called as visible text grows (e.g. to keep scroll pinned). */
  onProgress?: () => void;
}

/**
 * Reveals `text` progressively for a typewriter effect.
 * Skips animation for empty strings or when `active` is false.
 */
export function useTypewriter(
  text: string,
  { active, durationMs = 2400, onComplete, onProgress }: UseTypewriterOptions,
): { displayText: string; done: boolean } {
  const [length, setLength] = useState(active ? 0 : text.length);
  const [done, setDone] = useState(!active || text.length === 0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    if (!active || text.length === 0) {
      setLength(text.length);
      setDone(true);
      return;
    }

    setLength(0);
    setDone(false);

    const clampedDuration = Math.min(5000, Math.max(600, durationMs));
    const tickMs = 16;
    const totalTicks = Math.ceil(clampedDuration / tickMs);
    const charsPerTick = Math.max(1, Math.ceil(text.length / totalTicks));
    let current = 0;
    let cancelled = false;

    const timer = window.setInterval(() => {
      if (cancelled) return;
      current = Math.min(text.length, current + charsPerTick);
      setLength(current);
      onProgressRef.current?.();
      if (current >= text.length) {
        window.clearInterval(timer);
        setDone(true);
        onCompleteRef.current?.();
      }
    }, tickMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [text, active, durationMs]);

  return {
    displayText: text.slice(0, length),
    done,
  };
}
