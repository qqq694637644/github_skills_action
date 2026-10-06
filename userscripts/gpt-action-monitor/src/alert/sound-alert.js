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

  function emit(audioContext, durationMs) {
    const start = audioContext.currentTime + 0.02;
    const end = start + Math.max(0.1, durationMs / 1000);
    const tones = [880, 1175, 880];
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    gain.gain.setValueAtTime(0.0001, start);

    let index = 0;
    for (let toneStart = start; toneStart < end; toneStart += 0.3) {
      if (end - toneStart < 0.03) break;
      const frequency = tones[index % tones.length];
      oscillator.frequency.setValueAtTime(frequency, toneStart);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(0.18, toneStart + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, Math.min(toneStart + 0.2, end));
      index += 1;
      if (index % tones.length === 0) toneStart += 0.2;
    }

    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  function play(durationMs) {
    const audioContext = getContext();
    if (!audioContext) return false;
    if (audioContext.state === 'running') {
      emit(audioContext, durationMs);
      return true;
    }
    try {
      audioContext.resume().then(() => {
        if (audioContext.state === 'running') emit(audioContext, durationMs);
      }).catch(() => {});
    } catch (_) {
      return false;
    }
    return true;
  }

  async function test(durationMs) {
    if (!(await unlock())) return false;
    return play(durationMs);
  }

  return { unlock, play, test };
}

export function createSoundAlert({
  isEnabled,
  canArm = () => true,
  getDelayMs,
  getDurationMs,
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
    if (
      !isEnabled()
      || !canArm()
      || lastActivityAt === null
      || alertedActivityAt === lastActivityAt
    ) return;
    const remaining = lastActivityAt + getDelayMs() - now();
    if (remaining > 0) {
      timer = window.setTimeout(fireIfDue, remaining);
      return;
    }
    alertedActivityAt = lastActivityAt;
    player.play(getDurationMs());
  }

  function schedule() {
    clearTimer();
    if (
      !isEnabled()
      || !canArm()
      || lastActivityAt === null
      || alertedActivityAt === lastActivityAt
    ) return;
    const remaining = Math.max(0, lastActivityAt + getDelayMs() - now());
    timer = window.setTimeout(fireIfDue, remaining);
  }

  function observe(timestamp) {
    if (!canArm()) return false;
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return false;
    if (lastActivityAt !== null && parsed < lastActivityAt) return false;
    if (parsed !== lastActivityAt) alertedActivityAt = null;
    lastActivityAt = parsed;
    schedule();
    return true;
  }

  function check() {
    if (!isEnabled() || !canArm()) {
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
    if (isEnabled() && canArm()) schedule();
    else clearTimer();
  }

  return {
    observe,
    check,
    reset,
    settingsChanged,
    unlock: player.unlock,
    test: () => player.test(getDurationMs()),
  };
}
