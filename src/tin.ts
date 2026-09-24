export interface Point2D { x:number; y:number; z:number }
export interface Triangle { a:number; b:number; c:number }
interface Edge { a:number; b:number }
interface WorkingTriangle extends Triangle { cx:number; cy:number; r2:number }

function edgeKey(a:number,b:number){return (a<b?a:b)+":"+(a<b?b:a)}
function circumcircle(a:Point2D,b:Point2D,c:Point2D):{cx:number;cy:number;r2:number}|null{
  const d=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
  if(Math.abs(d)<1e-10)return null;
  const aa=a.x*a.x+a.y*a.y,bb=b.x*b.x+b.y*b.y,cc=c.x*c.x+c.y*c.y;
  const cx=(aa*(b.y-c.y)+bb*(c.y-a.y)+cc*(a.y-b.y))/d;
  const cy=(aa*(c.x-b.x)+bb*(a.x-c.x)+cc*(b.x-a.x))/d;
  return {cx,cy,r2:(cx-a.x)**2+(cy-a.y)**2};
}
function makeTriangle(a:number,b:number,c:number,pts:Point2D[]):WorkingTriangle|null{
  const cross=(pts[b].x-pts[a].x)*(pts[c].y-pts[a].y)-(pts[b].y-pts[a].y)*(pts[c].x-pts[a].x);
  if(Math.abs(cross)<1e-12)return null;
  const t:Triangle=cross>0?{a,b,c}:{a:c,b:b,c:a};
  const circle=circumcircle(pts[t.a],pts[t.b],pts[t.c]);
  return circle?{...t,...circle}:null;
}
export function delaunay(points:Point2D[]):Triangle[]{
  if(points.length<3)return [];
  let minX=points[0].x,maxX=points[0].x,minY=points[0].y,maxY=points[0].y;
  for(const p of points){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y)}
  const dx=maxX-minX,dy=maxY-minY,delta=Math.max(dx,dy,1),midX=(minX+maxX)/2,midY=(minY+maxY)/2;
  const pts=[...points,{x:midX-20*delta,y:midY-10*delta,z:0},{x:midX,y:midY+20*delta,z:0},{x:midX+20*delta,y:midY-10*delta,z:0}];
  const n=points.length,superA=n,superB=n+1,superC=n+2;
  let triangles:WorkingTriangle[]=[];
  const seed=makeTriangle(superA,superB,superC,pts);
  if(seed)triangles.push(seed);
  for(let i=0;i<n;i++){
    const p=pts[i];
    const bad=triangles.filter(t=>(p.x-t.cx)**2+(p.y-t.cy)**2<=t.r2+1e-8);
    const edges=new Map<string,Edge>();
    for(const t of bad)for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]] as Array<[number,number]>){
      const k=edgeKey(a,b);const old=edges.get(k);if(old)edges.delete(k);else edges.set(k,{a,b});
    }
    triangles=triangles.filter(t=>!bad.includes(t));
    for(const e of edges.values()){const nt=makeTriangle(e.a,e.b,i,pts);if(nt)triangles.push(nt)}
  }
  return triangles.filter(t=>t.a<n&&t.b<n&&t.c<n).map(({a,b,c})=>({a,b,c}));
}
