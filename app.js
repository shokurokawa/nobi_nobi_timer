(() => {
  const PHASE_DURATIONS = { stretch: 32000, rest: 8000 };
  const NEXT_PHASE = { stretch: 'rest', rest: 'stretch' };

  const els = {
    body: document.body,
    seconds: document.getElementById('seconds'),
    phase: document.getElementById('phase'),
    toggle: document.getElementById('btn-toggle'),
    toggleIcon: document.getElementById('btn-toggle-icon'),
    reset: document.getElementById('btn-reset'),
    mute: document.getElementById('btn-mute'),
    muteIcon: document.getElementById('btn-mute-icon'),
    ringProgress: document.querySelector('.ring-progress'),
  };

  const state = {
    phase: 'stretch',
    running: false,
    muted: false,
    phaseStartedAt: 0,        // performance.now() at current phase start
    pauseRemainMs: PHASE_DURATIONS.stretch,
    lastTickSecond: null,     // integer second since phase start, used to fire ticks
    rafId: null,
    cycleIndex: 0,            // increments at each cycle boundary (rest -> stretch)
  };

  // ---------- Audio ----------
  const audio = {
    ctx: null,
    masterGain: null,
    init() {
      if (this.ctx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = state.muted ? 0 : 1;
      this.masterGain.connect(this.ctx.destination);
    },
    async resume() {
      this.init();
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (e) { /* noop */ }
      }
    },
    setMuted(muted) {
      if (!this.masterGain) return;
      const t = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(t);
      this.masterGain.gain.linearRampToValueAtTime(muted ? 0 : 1, t + 0.05);
    },
    tick() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1800, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.06, t + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      osc.connect(gain).connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.05);
    },
    bell() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const partials = [
        { freq: 660, gain: 0.22, decay: 1.6 },
        { freq: 990, gain: 0.10, decay: 1.1 },
        { freq: 1320, gain: 0.05, decay: 0.7 },
      ];
      const bus = this.ctx.createGain();
      bus.gain.value = 1;
      bus.connect(this.masterGain);
      for (const p of partials) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(p.freq, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(p.gain, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + p.decay);
        osc.connect(g).connect(bus);
        osc.start(t);
        osc.stop(t + p.decay + 0.05);
      }
    },
  };

  // ---------- Timer loop ----------
  function totalMsForPhase(phase) {
    return PHASE_DURATIONS[phase];
  }

  function setPhase(phase) {
    state.phase = phase;
    els.body.dataset.phase = phase;
    els.phase.textContent = phase === 'stretch' ? 'Stretch' : 'Rest';
  }

  function render(remainMs) {
    const total = totalMsForPhase(state.phase);
    const clamped = Math.max(0, Math.min(remainMs, total));
    const fraction = clamped / total;
    // Use pathLength=1 so dasharray simply maps to fraction.
    els.ringProgress.setAttribute('stroke-dasharray', `${fraction} 1`);
    const seconds = Math.ceil(clamped / 1000);
    els.seconds.textContent = String(seconds);
  }

  function pulseFlash() {
    els.body.classList.remove('flash');
    // force reflow so animation can restart
    void els.body.offsetWidth;
    els.body.classList.add('flash');
  }

  function loop(now) {
    if (!state.running) return;
    const total = totalMsForPhase(state.phase);
    const elapsed = now - state.phaseStartedAt;
    const remain = total - elapsed;

    // Fire tick on each new second boundary (ceil bucket changes)
    const remainSec = Math.ceil(Math.max(0, remain) / 1000);
    if (state.lastTickSecond !== null && remainSec !== state.lastTickSecond && remainSec > 0) {
      audio.tick();
    }
    state.lastTickSecond = remainSec;

    if (remain <= 0) {
      // Transition: bell + switch phase
      audio.bell();
      pulseFlash();
      const overflow = -remain; // carry leftover into next phase for accuracy
      const next = NEXT_PHASE[state.phase];
      // Cycle boundary: rest -> stretch — pick a fresh random cat for the watermark
      if (state.phase === 'rest' && next === 'stretch') {
        state.cycleIndex += 1;
        rotateWatermark();
      }
      setPhase(next);
      state.phaseStartedAt = now - overflow;
      state.lastTickSecond = Math.ceil(Math.max(0, totalMsForPhase(next) - overflow) / 1000);
      render(totalMsForPhase(next) - overflow);
    } else {
      render(remain);
    }

    state.rafId = requestAnimationFrame(loop);
  }

  // ---------- Watermark rotation ----------
  function rotateWatermark() {
    const list = window.NOBI_CAT_IMAGES;
    const catState = window.NOBI_CAT_STATE;
    if (!list || list.length < 2 || !catState) return;
    let nextIndex;
    do {
      nextIndex = Math.floor(Math.random() * list.length);
    } while (nextIndex === catState.visibleIndex && list.length > 1);
    const visibleLayer = els.body.dataset.cat;
    const hiddenLayer = visibleLayer === 'a' ? 'b' : 'a';
    document.documentElement.style.setProperty(
      '--cat-' + hiddenLayer,
      "url('" + list[nextIndex] + "')"
    );
    els.body.dataset.cat = hiddenLayer;
    catState.visibleIndex = nextIndex;
  }

  // ---------- Wake Lock ----------
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.running) requestWakeLock();
  });

  // ---------- Controls ----------
  async function start() {
    await audio.resume();
    state.running = true;
    state.phaseStartedAt = performance.now() - (totalMsForPhase(state.phase) - state.pauseRemainMs);
    state.lastTickSecond = Math.ceil(state.pauseRemainMs / 1000);
    requestWakeLock();
    setToggleIcon(true);
    state.rafId = requestAnimationFrame(loop);
  }

  function pause() {
    if (!state.running) return;
    state.running = false;
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
    const elapsed = performance.now() - state.phaseStartedAt;
    state.pauseRemainMs = Math.max(0, totalMsForPhase(state.phase) - elapsed);
    releaseWakeLock();
    setToggleIcon(false);
  }

  function reset() {
    pause();
    setPhase('stretch');
    state.pauseRemainMs = PHASE_DURATIONS.stretch;
    state.lastTickSecond = null;
    state.cycleIndex = 0;
    // Watermark stays as-is so the user keeps the cat they were looking at.
    render(state.pauseRemainMs);
  }

  function setToggleIcon(running) {
    els.toggleIcon.textContent = running ? '❚❚' : '▶';
    els.toggle.setAttribute('aria-label', running ? '一時停止' : 'スタート');
  }

  function toggleMute() {
    state.muted = !state.muted;
    audio.init();
    audio.setMuted(state.muted);
    els.mute.setAttribute('aria-pressed', String(state.muted));
    els.muteIcon.textContent = state.muted ? '♪̸' : '♪';
    els.mute.setAttribute('aria-label', state.muted ? 'ミュート解除' : 'ミュート');
  }

  function toggleRun() {
    if (state.running) pause(); else start();
  }
  els.toggle.addEventListener('click', toggleRun);
  els.reset.addEventListener('click', reset);
  els.mute.addEventListener('click', toggleMute);

  // Tapping/clicking the timer dial also starts/pauses (same as the main button).
  document.querySelector('.dial').addEventListener('click', toggleRun);

  // Keyboard shortcuts: space=toggle, R=reset, M=mute
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); els.toggle.click(); }
    else if (e.key === 'r' || e.key === 'R') { reset(); }
    else if (e.key === 'm' || e.key === 'M') { toggleMute(); }
  });

  // Initial render
  setPhase('stretch');
  render(PHASE_DURATIONS.stretch);
})();
