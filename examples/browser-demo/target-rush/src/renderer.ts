import { Game, WIDTH, type Target } from './game';
const TARGET_COLOR = '#a2d5c9';
interface Popup { x:number; y:number; text:string; life:number; color:string }
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private popups: Popup[] = [];
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  constructor(private canvas: HTMLCanvasElement, private game: Game) {
    this.ctx = canvas.getContext('2d')!;
  }
  clear(): void { this.popups = []; }
  hit(target: Target, points: number): void {
    this.popups.push({x:target.x,y:target.y-30,text:`+${points}`,life:.4,color:TARGET_COLOR});
  }
  miss(x:number,y:number): void { this.popups.push({x,y,text:'×',life:.3,color:'#a9b2bf'}); }
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
    c.fillStyle='#1e242d';c.fillRect(0,0,WIDTH,g.height);
    if(g.phase==='playing') for(const t of g.targets) this.target(t,now);
    for(const p of this.popups) {
      p.life-=dt;if(!this.reduced)p.y-=45*dt;
      c.globalAlpha=Math.max(0,Math.min(1,p.life*4));c.fillStyle=p.color;c.font='bold 27px monospace';c.textAlign='center';c.fillText(p.text,p.x,p.y);
    }
    this.popups=this.popups.filter(p=>p.life>0);
    c.globalAlpha=1;
  }
  private target(t:Target,now:number):void {
    const c=this.ctx;
    const age=now-t.bornAt;
    const scale=this.reduced ? 1 : Math.min(1, .6+age/180);
    c.save();c.translate(t.x,t.y);c.scale(scale,scale);
    c.fillStyle=TARGET_COLOR;
    c.beginPath();c.arc(0,0,t.radius,0,Math.PI*2);c.fill();
    c.fillStyle='#1e242d';c.beginPath();c.arc(0,0,t.radius*.65,0,Math.PI*2);c.fill();
    c.fillStyle=TARGET_COLOR;c.beginPath();c.arc(0,0,t.radius*.3,0,Math.PI*2);c.fill();
    c.strokeStyle=TARGET_COLOR;c.globalAlpha=.5;c.lineWidth=3;c.beginPath();
    c.arc(0,0,t.radius+9,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,(t.expiresAt-now)/(t.expiresAt-t.bornAt)));c.stroke();
    c.restore();
  }
}
