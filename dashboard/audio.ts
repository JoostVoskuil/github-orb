export class Chime {
  ctx: AudioContext | null = null;

  async enable() {
    this.ctx ??= new AudioContext();
    await this.ctx.resume();
  }

  get ready() {
    return this.ctx?.state === 'running';
  }

  play(sound, volume) {
    if (!this.ready || !sound?.notes?.length || volume <= 0) return;
    let t = this.ctx.currentTime + 0.02;
    for (const [freq, ms] of sound.notes) {
      const dur = ms / 1000;
      if (freq > 0) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = sound.wave ?? 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.3 * volume, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      }
      t += dur;
    }
  }
}

export function inQuietHours(quietHours, date = new Date()) {
  if (!quietHours?.enabled) return false;
  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const now = date.getHours() * 60 + date.getMinutes();
  const start = toMin(quietHours.start);
  const end = toMin(quietHours.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
