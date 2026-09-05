/**
 * Synthesized rather than an audio file: a two-note bell "ting" via Web Audio,
 * so there's no binary asset to ship and no network fetch to fail. One shared
 * AudioContext.
 *
 * Browsers only let a context leave `suspended` inside the call stack of a
 * real user gesture (click/keydown) — a socket event firing later does not
 * count, no matter how much the agent has clicked around since page load. So
 * the context is created (and resumed) the moment the console sees its first
 * genuine interaction, via `unlockAudioContext` wired to a one-time listener
 * in AgentConsoleShell, well before any notification needs to play through it.
 */
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/** Call from inside a real user gesture handler (click/keydown), once, on mount. */
export function unlockAudioContext(): void {
  const audioCtx = getContext();
  if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume();
}

function playTone(
  audioCtx: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  peakGain: number,
) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

/** Bright two-note "ting" — a fifth apart, second note ringing longer. */
export function playAssignmentChime(): void {
  const audioCtx = getContext();
  if (!audioCtx) return;
  // Best-effort: harmless if it's still suspended and this resume() is also
  // rejected for lacking a gesture — unlockAudioContext is the real fix.
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  const now = audioCtx.currentTime;
  playTone(audioCtx, 1318.5, now, 0.18, 0.2); // E6
  playTone(audioCtx, 1975.5, now + 0.06, 0.45, 0.18); // B6
}
