import { SOUND_ALERT_DELAY_MS } from '../constants.js';

function createWebAudioPlayer() {
  let context = null;

  function getContext() {
    if (context) return context;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
    return context;
  }

  async function unlock() {
    const audioContext = getContext();
    if (!audioContext) return false;
    if (audioContext.state === 'suspended') {
      try { await audioContext.resume(); } catch (_) { return false; }
    }
    return audioContext.state === 'running';
  }

  function emit(audioContext) {
    const start = audioContext.currentTime + 0.02;
    const tones = [880, 1175, 880];
    tones.forEach((frequency, index) => {
      const toneStart = start + index * 0.3;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, toneStart);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(0.18, toneStart + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.2);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneStart + 0.22);
    });
  }

  function play() {
    const audioContext = getContext();
    if (!audioContext) return false;
    if (audioContext.state === 'running') {
      emit(audioContext);
      return true;
    }
    try {
      audioContext.resume().then(() => {
        if (audioContext.state === 'running') emit(audioContext);
      }).catch(() => {});
    } catch (_) {
      return false;
    }
    return true;
  }

  async function test() {
    if (!(await unlock())) return false;
    return play();
  }

  return { unlock, play, test };
}

export function createSoundAlert({
  isEnabled,
  delayMs = SOUND_ALERT_DELAY_MS,
  now = () => Date.now(),
  player = createWebAudioPlayer(),
}) {
  let timer = null;
  let lastActivityAt = null;
  let alertedActivityAt = null;

  function clearTimer() {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function fireIfDue() {
    clearTimer();
    if (!isEnabled() || lastActivityAt === null || alertedActivityAt === lastActivityAt) return;
    const remaining = lastActivityAt + delayMs - now();
    if (remaining > 0) {
      timer = window.setTimeout(fireIfDue, remaining);
      return;
    }
    alertedActivityAt = lastActivityAt;
    player.play();
  }

  function schedule() {
    clearTimer();
    if (!isEnabled() || lastActivityAt === null || alertedActivityAt === lastActivityAt) return;
    const remaining = Math.max(0, lastActivityAt + delayMs - now());
    timer = window.setTimeout(fireIfDue, remaining);
  }

  function observe(timestamp) {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return false;
    if (lastActivityAt !== null && parsed < lastActivityAt) return false;
    if (parsed !== lastActivityAt) alertedActivityAt = null;
    lastActivityAt = parsed;
    schedule();
    return true;
  }

  function check() {
    if (!isEnabled()) {
      clearTimer();
      return;
    }
    if (lastActivityAt !== null && alertedActivityAt !== lastActivityAt) {
      fireIfDue();
    }
  }

  function reset() {
    clearTimer();
    lastActivityAt = null;
    alertedActivityAt = null;
  }

  function settingsChanged() {
    if (isEnabled()) schedule();
    else clearTimer();
  }

  return {
    observe,
    check,
    reset,
    settingsChanged,
    unlock: player.unlock,
    test: player.test,
  };
}
