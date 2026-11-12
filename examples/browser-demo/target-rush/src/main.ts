import './style.css';
import { Game, ROUND_MS, scoreForCombo, type RoundResult } from './game';
import { canvasPoint } from './input';
import { Renderer } from './renderer';
import { Sound } from './audio';
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('game');
const intro = element('intro'), results = element('results');
const sound = new Sound();

/** Integration boundary: fires once per completed round, before showing results. */
function onRoundEnd(result: Readonly<RoundResult>): void {
  element('final-score').textContent = String(result.score);
  element('hits').textContent = String(result.hits);
  element('accuracy').textContent = `${result.shots ? Math.round(result.hits/result.shots*100) : 0}%`;
  element('best-combo').textContent = String(result.bestCombo);
  element('result-note').textContent = result.hits ? 'Found your flow? Go again.' : 'Your next rush is one tap away.';
  results.hidden = false;
  element('restart').focus({preventScroll:true});
  element('arena-label').textContent = 'THAT’S A WRAP';
  sound.play('end');
  window.dispatchEvent(new CustomEvent<Readonly<RoundResult>>('targetrush:roundend', { detail: result }));
}
const game = new Game(Math.random, onRoundEnd);
const renderer = new Renderer(canvas,game);
function start(): void {
  sound.unlock();
  renderer.clear();
  intro.hidden=true;results.hidden=true;
  game.start(performance.now());
  element('arena-label').textContent = 'ROUND IN PROGRESS';
  sound.play('start');
  // The hidden start button must not retain keyboard focus during play.
  canvas.tabIndex=-1;canvas.focus({preventScroll:true});
}
element('start').addEventListener('click',start);
element('restart').addEventListener('click',start);
element('mute').addEventListener('click',() => {
  sound.unlock();sound.muted=!sound.muted;
  const button=element('mute');
  button.setAttribute('aria-pressed',String(sound.muted));
  button.setAttribute('aria-label',sound.muted?'Unmute sound':'Mute sound');
  button.innerHTML=sound.muted?'♪ <span>SOUND OFF</span>':'♪ <span>SOUND ON</span>';
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
  element('score').textContent=String(game.score).padStart(4,'0');
  const seconds=(remaining/1000).toFixed(1).split('.');
  element('timer').innerHTML=`${seconds[0]}<span>.${seconds[1]}</span>`;
  element('combo').textContent=`×${scoreForCombo(Math.max(1,game.combo))/10}`;
  element('combo-label').textContent=game.combo?`${game.combo} HIT STREAK`:'BUILD YOUR STREAK';
  element('time-fill').style.width=`${remaining/ROUND_MS*100}%`;
  document.body.classList.toggle('urgent',game.phase==='playing' && remaining<10000);
  renderer.draw(now,Math.min(.05,(now-previous)/1000));previous=now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// A hidden tab still consumes round time. Refresh immediately on returning.
document.addEventListener('visibilitychange',() => { if(!document.hidden) game.update(performance.now()); });
