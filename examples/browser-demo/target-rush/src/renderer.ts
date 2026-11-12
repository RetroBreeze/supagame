import { Game, WIDTH, type Target } from './game';
const COLORS = ['#ff7099', '#83f3cf', '#ffe18e'];
interface Particle { x:number; y:number; vx:number; vy:number; life:number; color:string }
interface Popup { x:number; y:number; text:string; life:number; color:string }
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  constructor(private canvas: HTMLCanvasElement, private game: Game) {
    this.ctx = canvas.getContext('2d')!;
  }
  clear(): void { this.particles = []; this.popups = []; }
  hit(target: Target, points: number): void {
    const color = COLORS[target.color]!;
    for(let i=0;i<(this.reduced ? 0 : 18);i++) {
      const angle = Math.random()*Math.PI*2;
      const speed = 70+Math.random()*240;
      this.particles.push({x:target.x,y:target.y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,life:.5+Math.random()*.25,color});
    }
    this.popups.push({x:target.x,y:target.y-30,text:`+${points}`,life:.65,color});
  }
  miss(x:number,y:number): void { this.popups.push({x,y,text:'MISS',life:.4,color:'#a59ab8'}); }
  draw(now:number, dt:number): void {
    const {canvas,ctx:c,game:g} = this;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(rect.width*ratio), height = Math.round(rect.height*ratio);
    if(canvas.width!==width || canvas.height!==height) { canvas.width=width;canvas.height=height; }
    const logicalHeight = WIDTH*rect.height/rect.width;
    if (g.height !== logicalHeight) {
      for(const t of g.targets) t.y *= logicalHeight/g.height;
      g.height=logicalHeight;
    }
    g.radius = rect.width < 600 ? 56 : 38;
    c.setTransform(width/WIDTH,0,0,height/g.height,0,0);
    c.clearRect(0,0,WIDTH,g.height);
    c.fillStyle='#17172c';c.fillRect(0,0,WIDTH,g.height);
    c.strokeStyle='#ffffff05';c.lineWidth=1;
    for(let x=0;x<WIDTH;x+=40) {c.beginPath();c.moveTo(x,0);c.lineTo(x,g.height);c.stroke();}
    for(let y=0;y<g.height;y+=40) {c.beginPath();c.moveTo(0,y);c.lineTo(WIDTH,y);c.stroke();}
    if(g.phase==='playing') for(const t of g.targets) this.target(t,now);
    else {
      // Ambient targets sit behind the title and result screens.
      for(let i=0;i<4;i++) this.target({id:i,x:[100,770,160,790][i]!,y:[g.height*.3,g.height*.21,g.height*.78,g.height*.74][i]!,radius:32,bornAt:0,expiresAt:Infinity,color:i%3},now,true);
    }
    for(const p of this.particles) {
      p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=250*dt;
      c.globalAlpha=Math.max(0,Math.min(1,p.life*2));c.fillStyle=p.color;
      c.fillRect(p.x,p.y,5,5);
    }
    this.particles=this.particles.filter(p=>p.life>0);
    for(const p of this.popups) {
      p.life-=dt;if(!this.reduced)p.y-=45*dt;
      c.globalAlpha=Math.max(0,Math.min(1,p.life*4));c.fillStyle=p.color;c.font='bold 27px monospace';c.textAlign='center';c.fillText(p.text,p.x,p.y);
    }
    this.popups=this.popups.filter(p=>p.life>0);
    c.globalAlpha=1;
  }
  private target(t:Target,now:number,ambient=false):void {
    const c=this.ctx, color=COLORS[t.color]!;
    const age=now-t.bornAt;
    const scale=this.reduced||ambient ? 1 : Math.min(1, .6+age/180);
    c.save();c.translate(t.x,t.y);c.scale(scale,scale);c.globalAlpha=ambient?.28:1;
    c.shadowColor=color;c.shadowBlur=ambient?0:18;c.fillStyle=color;
    c.beginPath();c.arc(0,0,t.radius,0,Math.PI*2);c.fill();c.shadowBlur=0;
    c.fillStyle='#1c1a32';c.beginPath();c.arc(0,0,t.radius*.72,0,Math.PI*2);c.fill();
    c.fillStyle=color;c.beginPath();c.arc(0,0,t.radius*.46,0,Math.PI*2);c.fill();
    c.fillStyle='#1c1a32';c.beginPath();c.arc(0,0,t.radius*.19,0,Math.PI*2);c.fill();
    if(!ambient){
      c.strokeStyle=color;c.globalAlpha=.4;c.lineWidth=3;c.beginPath();
      c.arc(0,0,t.radius+9,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,(t.expiresAt-now)/(t.expiresAt-t.bornAt)));c.stroke();
    }
    c.restore();
  }
}
