/**
 * Physical Haptic Vibration & Fallback Audio Confirmation Engine
 * 
 * Provides:
 * 1. Browser Vibration API (`navigator.vibrate`) for physical confirmation when available (mobile/touch devices).
 * 2. High-quality procedural Web Audio confirmation sounds on desktop/laptop devices where vibration is not supported.
 * 
 * Trigger events:
 * - 'Free delivery threshold reached / Free delivery availed'
 * - 'Place Order'
 */

// Vibration patterns in milliseconds [vibrate, pause, vibrate, ...]
export const VIBRATION_PATTERNS = {
  freeDelivery: [40, 50, 60, 50, 100], // Celebratory crescendo vibration
  placeOrder: [50, 60, 70, 60, 120],   // Strong multi-pulse confirmation
} as const;

export type TargetedFeedbackType = 'freeDelivery' | 'placeOrder';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch (e) {
    console.debug('Web Audio API not supported or blocked:', e);
    return null;
  }
}

/**
 * Check if the browser supports the Vibration API
 */
export function isVibrationSupported(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator && typeof navigator.vibrate === 'function';
}

/**
 * Trigger the device vibration API safely
 */
export function triggerVibration(pattern: number | number[] | readonly number[]): boolean {
  if (!isVibrationSupported()) return false;
  try {
    return navigator.vibrate(pattern as any);
  } catch (err) {
    console.debug('Vibration API call failed:', err);
    return false;
  }
}

/**
 * Procedural Web Audio Sound Effect for desktop/laptop where vibration is not available
 */
export function playSound(type: TargetedFeedbackType): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;

  try {
    if (type === 'freeDelivery') {
      // Melodic celebratory arpeggio: C5 -> E5 -> G5 -> C6
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const noteStart = now + index * 0.07;
        const noteDuration = 0.28;

        osc.type = index === notes.length - 1 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, noteStart);

        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.linearRampToValueAtTime(0.12, noteStart + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDuration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(noteStart);
        osc.stop(noteStart + noteDuration);
      });
    } else if (type === 'placeOrder') {
      // Warm triumphant confirmation chord
      const baseNotes = [261.63, 392.00, 523.25, 659.25]; // C4, G4, C5, E5
      baseNotes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = now + idx * 0.04;
        const duration = 0.42;

        osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, start);

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.13, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(start);
        osc.stop(start + duration);
      });
    }
  } catch (err) {
    console.debug('Error playing sound effect:', err);
  }
}

/**
 * Triggers vibration if available, or sound effects if vibration is not available (desktop/laptop)
 */
export function triggerConfirmation(type: TargetedFeedbackType): void {
  const hasVibe = isVibrationSupported();
  
  if (hasVibe) {
    const pattern = type === 'freeDelivery' 
      ? VIBRATION_PATTERNS.freeDelivery 
      : VIBRATION_PATTERNS.placeOrder;
    const didVibrate = triggerVibration(pattern);
    // If vibration API is present but failed or returned false, play audio as fallback
    if (!didVibrate) {
      playSound(type);
    }
  } else {
    // Desktop/Laptop: Vibration not available -> play sound effect
    playSound(type);
  }
}

export const feedback = {
  /** Triggered only when the Free Delivery Threshold is reached / availed */
  freeDeliveryAvailed: () => triggerConfirmation('freeDelivery'),

  /** Triggered on Place Order button press */
  placeOrder: () => triggerConfirmation('placeOrder'),

  /** Check if vibration is available */
  hasVibration: isVibrationSupported,
};

export default feedback;
