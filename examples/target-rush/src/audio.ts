/** Small synthesized sounds; no downloads and no sound before a user gesture. */
export class Sound {
  muted = false;
  private context?: AudioContext;
  unlock(): void {
    try { this.context ??= new AudioContext(); void this.context.resume().catch(() => {}); } catch { /* Audio is optional. */ }
  }
  play(kind: 'hit' | 'miss' | 'start' | 'end', combo = 0): void {
    if (this.muted || !this.context || this.context.state !== 'running') return;
    const ctx = this.context;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const frequency = kind === 'hit' ? 420 + Math.min(combo,20)*28 : kind === 'start' ? 520 : kind === 'end' ? 330 : 120;
    osc.type = kind === 'miss' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(frequency, now);
    osc.frequency.exponentialRampToValueAtTime(kind === 'miss' || kind === 'end' ? frequency/2 : frequency*1.7, now+.12);
    gain.gain.setValueAtTime(.0001, now);
    gain.gain.exponentialRampToValueAtTime(.08, now+.008);
    gain.gain.exponentialRampToValueAtTime(.0001, now+.17);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now); osc.stop(now+.18);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
}
