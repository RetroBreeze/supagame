import { describe, expect, it } from 'vitest';
import { Game, ROUND_MS, scoreForCombo } from '../src/game';
import { canvasPoint } from '../src/input';

describe('round rules', () => {
  it('starts a fresh 30 second round with three bounded targets', () => {
    const game = new Game(() => 0.5);
    game.start(100);
    expect(game.remaining(100)).toBe(ROUND_MS);
    expect(game.targets).toHaveLength(3);
    for (const t of game.targets) {
      expect(t.x).toBeGreaterThanOrEqual(t.radius);
      expect(t.x).toBeLessThanOrEqual(900 - t.radius);
      expect(t.y).toBeGreaterThanOrEqual(t.radius);
      expect(t.y).toBeLessThanOrEqual(560 - t.radius);
    }
    expect(new Set(game.targets.map(t => `${t.x},${t.y}`)).size).toBe(3);
  });
  it('uses circular hit detection, replaces hits immediately and calculates combos', () => {
    const game = new Game(() => 0.5);
    game.start(0);
    const first = game.targets[0]!;
    expect(game.hit(first.x + first.radius, first.y + first.radius, 1)).toBeNull();
    for (let i = 1; i <= 12; i++) {
      const t = game.targets[0]!;
      expect(game.hit(t.x, t.y, i)?.points).toBe(scoreForCombo(i));
      expect(game.targets).toHaveLength(3);
    }
    expect(game.score).toBe(Array.from({length: 12}, (_, i) => scoreForCombo(i + 1)).reduce((a,b) => a+b, 0));
    expect(Number.isSafeInteger(game.score)).toBe(true);
    expect(scoreForCombo(100)).toBe(40);
  });
  it('expires targets before processing input and increases speed', () => {
    const game = new Game(() => 0.5);
    game.start(0);
    const t = game.targets[0]!;
    game.hit(t.x, t.y, 1);
    game.update(2000);
    expect(game.combo).toBe(0);
    expect(game.expired).toBeGreaterThan(0);
    const early = game.targets[0]!;
    game.update(25000);
    const late = game.targets[0]!;
    expect(late.expiresAt - late.bornAt).toBeLessThan(early.expiresAt - early.bornAt);
    expect(game.hit(late.x, late.y, late.expiresAt)).toBeNull();
  });
  it('finishes exactly once at the deadline even after a suspended frame, rejects late input and restarts cleanly', () => {
    const results: number[] = [];
    const game = new Game(() => 0.5, result => results.push(result.score));
    game.start(500);
    const t = game.targets[0]!;
    game.hit(t.x, t.y, 501);
    game.update(30500);
    expect(game.phase).toBe('over');
    expect(game.remaining(99999)).toBe(0);
    expect(game.hit(t.x, t.y, 30500)).toBeNull();
    game.update(99999);
    expect(results).toEqual([10]);
    game.start(100000);
    expect(game.score).toBe(0);
    expect(game.combo).toBe(0);
    expect(game.hits).toBe(0);
    expect(game.shots).toBe(0);
    expect(game.expired).toBe(0);
    expect(game.remaining(100000)).toBe(30000);
    game.update(140000);
    expect(results).toEqual([10, 0]);
  });
  it('resets combo on misses and ignores idle input', () => {
    const game = new Game();
    expect(game.hit(0,0,0)).toBeNull();
    expect(game.shots).toBe(0);
    game.start(0);
    const t = game.targets[0]!;
    game.hit(t.x,t.y,1);
    game.hit(-1,-1,2);
    expect(game.combo).toBe(0);
    expect(game.shots).toBe(2);
    expect(game.hits).toBe(1);
  });
});

it('maps desktop and mobile CSS coordinates into the same logical playfield', () => {
  expect(canvasPoint(460, 300, {left:10,top:20,width:900,height:560})).toEqual({x:450,y:280});
  expect(canvasPoint(190, 132, {left:10,top:20,width:360,height:224})).toEqual({x:450,y:280});
});
