import { WIDTH, HEIGHT } from './game';
export function canvasPoint(clientX: number, clientY: number, rect: {left:number;top:number;width:number;height:number}, height = HEIGHT): {x:number;y:number} {
  return {x:(clientX-rect.left)*WIDTH/rect.width, y:(clientY-rect.top)*height/rect.height};
}
