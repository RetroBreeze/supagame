import './style.css';
import { Game, ROUND_MS, scoreForCombo, type RoundResult } from './game';
import { canvasPoint } from './input';
import { Renderer } from './renderer';
import { Sound } from './audio';
import { setupLeaderboard } from './leaderboard';
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('game');
const intro = element('intro'), results = element('results');
const sound = new Sound();
element('round-duration').textContent = String(ROUND_MS / 1000);
const leaderboard = setupLeaderboard();
const nameInput = element<HTMLInputElement>('player-name');
let roundName = '';
void leaderboard.refresh();

/** Integration boundary: fires once per completed round, before showing results. */
function onRoundEnd(result: Readonly<RoundResult>): void {
  element('final-score').textContent = String(result.score);
  element('hits').textContent = String(result.hits);
  element('accuracy').textContent = `${result.shots ? Math.round(result.hits/result.shots*100) : 0}%`;
  element('best-combo').textContent = String(result.bestCombo);
  results.hidden = false;
  element('restart').focus({preventScroll:true});
  sound.play('end');
  void leaderboard.submit(result.score, roundName);
  window.dispatchEvent(new CustomEvent<Readonly<RoundResult>>('targetrush:roundend', { detail: result }));
}
const game = new Game(Math.random, onRoundEnd);
const renderer = new Renderer(canvas,game);
function start(): void {
  roundName = nameInput.value.trim();
  nameInput.value = roundName;
  if (!nameInput.reportValidity()) return;
  sound.unlock();
  renderer.clear();
  intro.hidden=true;results.hidden=true;
  game.start(performance.now());
  sound.play('start');
  // The hidden start button must not retain keyboard focus during play.
  canvas.tabIndex=-1;canvas.focus({preventScroll:true});
}
element('start-form').addEventListener('submit', event => { event.preventDefault(); start(); });
element('restart').addEventListener('click', () => {
  results.hidden = true;
  intro.hidden = false;
  void leaderboard.refresh();
  element('start').focus({ preventScroll: true });
});
element('mute').addEventListener('click',() => {
  sound.unlock();sound.muted=!sound.muted;
  const button=element('mute');
  button.setAttribute('aria-pressed',String(sound.muted));
  button.setAttribute('aria-label',sound.muted?'Unmute sound':'Mute sound');
  button.textContent=sound.muted?'Sound off':'Sound on';
});
canvas.addEventListener('pointerdown',event => {
  if(game.phase!=='playing' || (event.pointerType==='mouse' && event.button!==0))return;
  event.preventDefault();
  const point=canvasPoint(event.clientX,event.clientY,canvas.getBoundingClientRect(),game.height);
  const hit=game.hit(point.x,point.y,performance.now());
  if(hit){renderer.hit(hit.target,hit.points);sound.play('hit',game.combo);}
  else if(game.phase==='playing'){renderer.miss(point.x,point.y);sound.play('miss');}
});
let previous=performance.now();
function frame(now:number):void {
  game.update(now);
  const remaining=game.phase==='ready'?ROUND_MS:game.remaining(now);
  element('score').textContent=String(game.score);
  element('timer').textContent=(remaining/1000).toFixed(1);
  element('combo').textContent=`×${scoreForCombo(Math.max(1,game.combo))/10}`;
  renderer.draw(now,Math.min(.05,(now-previous)/1000));previous=now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// A hidden tab still consumes round time. Refresh immediately on returning.
document.addEventListener('visibilitychange',() => { if(!document.hidden) game.update(performance.now()); });
