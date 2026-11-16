import type { TradingSoundPort } from "../contracts/ports.js";

type AudioContextConstructor = new () => AudioContext;

/**
 * Default execution sound: one short tone through Web Audio. Nothing is created until the first sound, and an
 * environment without Web Audio (or one that refuses it) stays silent rather than failing a trading update.
 */
export function createDefaultExecutionSound(
  audio: AudioContextConstructor | undefined = (globalThis as { AudioContext?: AudioContextConstructor }).AudioContext,
): TradingSoundPort & { close(): void } {
  let context: AudioContext | undefined;
  let closed = false;
  return {
    playExecution() {
      if (closed || !audio) return;
      try {
        context ??= new audio();
        const start = context.currentTime;
        const tone = context.createOscillator();
        const volume = context.createGain();
        tone.type = "sine";
        tone.frequency.setValueAtTime(880, start);
        volume.gain.setValueAtTime(0.0001, start);
        volume.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
        volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        tone.connect(volume);
        volume.connect(context.destination);
        tone.start(start);
        tone.stop(start + 0.2);
      } catch {
        /* Autoplay policies and missing output devices leave executions silent. */
      }
    },
    close() {
      closed = true;
      void context?.close().catch(() => {});
      context = undefined;
    },
  };
}
