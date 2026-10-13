// The arrangement on small screens. On phones, held either way, and on small tablets held upright, the model fills the
// screen and the panels open one at a time, as sheets, from a bar at the bottom. These are the parts of it that are
// pure geometry, kept apart from the page so they can be tested.

// Narrow screens, and phones on their side: short, with a touch screen. The style sheet uses the same queries.
export const COMPACT="(max-width: 900px), (max-height: 520px) and (pointer: coarse)";
// The compact layout on its side, where the sheets open from the left instead of from the bottom.
export const COMPACT_SIDE="(max-width: 900px) and (orientation: landscape), (max-height: 520px) and (pointer: coarse) and (orientation: landscape)";

export interface Rect { x0:number; y0:number; x1:number; y1:number }

// How far, and how much smaller, the view is drawn so that the model stays in the part of the screen the open panels
// leave free (free), shrunk as that part is smaller than the room the model has with no panel open (room), but by no
// more than `min`. The result gives camera.setViewOffset(width·k, height·k, x, y, width, height): the frame is drawn k
// times its size and its centre lands on the centre of the free part.
export function viewShift(width:number,height:number,free:Rect,room:Rect,min=0.3){
  const w=Math.max(free.x1-free.x0,1),h=Math.max(free.y1-free.y0,1);
  const k=Math.min(1,Math.max(min,Math.min(w/Math.max(room.x1-room.x0,1),h/Math.max(room.y1-room.y0,1))));
  return {x:width*k/2-(free.x0+free.x1)/2,y:height*k/2-(free.y0+free.y1)/2,k};
}

// The half-angle of the view that a model must fit in, for a camera with this vertical field of view (radians) on a
// screen `height` pixels tall, in a room of w × h pixels: on an upright phone the width limits it, not the height.
export function fitAngle(fov:number,w:number,h:number,height:number){
  return Math.atan(Math.tan(fov/2)*Math.min(w,h)/height);
}

// The distance from a point to a segment on the screen, and where along the segment (0–1) the nearest point lies.
export function segmentDistance(px:number,py:number,ax:number,ay:number,bx:number,by:number){
  const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy;
  const t=l>0?Math.min(1,Math.max(0,((px-ax)*dx+(py-ay)*dy)/l)):0;
  return {d:Math.hypot(px-ax-t*dx,py-ay-t*dy),t};
}
