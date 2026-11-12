export const WIDTH = 900;
export const HEIGHT = 560;
export const ROUND_MS = 30_000;
export interface Target { id: number; x: number; y: number; radius: number; bornAt: number; expiresAt: number; color: number }
export interface RoundResult { score: number; hits: number; shots: number; bestCombo: number; expired: number }
export const scoreForCombo = (combo: number): number => 10 * Math.min(4, 1 + Math.floor(Math.max(0, combo - 1) / 5));

/** Clock and randomness are injected; scoring depends only on accepted hits and combo. */
export class Game {
  height = HEIGHT;
  radius = 38;
  phase: 'ready' | 'playing' | 'over' = 'ready';
  targets: Target[] = [];
  score = 0;
  hits = 0;
  shots = 0;
  combo = 0;
  bestCombo = 0;
  expired = 0;
  private startedAt = 0;
  private nextId = 0;
  constructor(private random: () => number = Math.random, private onRoundEnd: (result: Readonly<RoundResult>) => void = () => {}) {}
  start(now: number): void {
    this.startedAt = now;
    this.score = this.hits = this.shots = this.combo = this.bestCombo = this.expired = 0;
    this.targets = [];
    this.phase = 'playing';
    for (let i = 0; i < 3; i++) this.spawn(now);
  }
  remaining(now: number): number { return Math.max(0, ROUND_MS - (now - this.startedAt)); }
  update(now: number): void {
    if (this.phase !== 'playing') return;
    if (this.remaining(now) <= 0) {
      this.phase = 'over';
      this.targets = [];
      this.onRoundEnd(Object.freeze({score:this.score, hits:this.hits, shots:this.shots, bestCombo:this.bestCombo, expired:this.expired}));
      return;
    }
    const expired = this.targets.filter(t => t.expiresAt <= now);
    if (expired.length) {
      this.combo = 0;
      this.expired += expired.length;
      this.targets = this.targets.filter(t => t.expiresAt > now);
      for (const _ of expired) { void _; this.spawn(now); }
    }
  }
  hit(x: number, y: number, now: number): { target: Target; points: number } | null {
    // Capture IDs before expiry so a tap on an expired target cannot hit its replacement.
    const ids = new Set(this.targets.map(t => t.id));
    this.update(now);
    if (this.phase !== 'playing') return null;
    this.shots++;
    const target = this.targets.find(t => ids.has(t.id) && Math.hypot(t.x-x,t.y-y) <= t.radius);
    if (!target) { this.combo = 0; return null; }
    this.hits++;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const points = scoreForCombo(this.combo);
    this.score += points;
    this.targets = this.targets.filter(t => t.id !== target.id);
    this.spawn(now);
    return { target, points };
  }
  private spawn(now: number): void {
    const radius = this.radius;
    // Shuffled grid cells guarantee separation, including with a constant random source.
    const cells = Array.from({length: 20}, (_, i) => ({x:90+(i%5)*180, y:(70+Math.floor(i/5)*140)*this.height/HEIGHT}));
    const free = cells.filter(c => this.targets.every(t => Math.hypot(c.x-t.x,c.y-t.y) > radius*2+24));
    const cell = free[Math.min(free.length-1, Math.floor(this.random()*free.length))]!;
    const life = 2000 - Math.min(1, (now-this.startedAt)/ROUND_MS)*1150;
    this.targets.push({id:this.nextId++, x:cell.x+(this.random()-0.5)*28, y:cell.y+(this.random()-0.5)*28, radius, bornAt:now, expiresAt:now+life, color:Math.floor(this.random()*3)});
  }
}
