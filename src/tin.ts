export interface XY { x:number; y:number }
export interface Point2D extends XY { z:number }
export interface Triangle { a:number; b:number; c:number }
interface Edge { a:number; b:number }

// Vertex "at infinity": a triangle (a, b, GHOST) stands for the open half-plane left of a→b, outside the hull.
const GHOST=-1;
function edgeKey(a:number,b:number){return (a<b?a:b)+":"+(a<b?b:a)}
function orient(p:XY,q:XY,r:XY){return (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)}
// Positive when d lies strictly inside the circumcircle of the counter-clockwise triangle a, b, c.
function incircle(a:XY,b:XY,c:XY,d:XY){
  const ax=a.x-d.x,ay=a.y-d.y,bx=b.x-d.x,by=b.y-d.y,cx=c.x-d.x,cy=c.y-d.y;
  return (ax*ax+ay*ay)*(bx*cy-by*cx)-(bx*bx+by*by)*(ax*cy-ay*cx)+(cx*cx+cy*cy)*(ax*by-ay*bx);
}
function conflicts(t:Triangle,p:XY,pts:XY[]){
  if(t.c!==GHOST)return incircle(pts[t.a],pts[t.b],pts[t.c],p)>0;
  const a=pts[t.a],b=pts[t.b],o=orient(a,b,p);
  if(o!==0)return o>0;
  return (p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y)>0&&(p.x-b.x)*(a.x-b.x)+(p.y-b.y)*(a.y-b.y)>0;
}
// Bowyer-Watson triangulation of the XY positions with a ghost vertex, so the result always covers the convex hull.
// Triangles are counter-clockwise; collinear input gives no triangles and repeated positions are left out.
export function delaunay(points:XY[]):Triangle[]{
  const n=points.length;
  if(n<3)return [];
  let minX=points[0].x,maxX=points[0].x,minY=points[0].y,maxY=points[0].y;
  for(const p of points){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y)}
  const midX=(minX+maxX)/2,midY=(minY+maxY)/2;
  // Work about the bounding-box centre to keep the predicates accurate in projected coordinates (e.g. UTM).
  const pts:XY[]=points.map(p=>({x:p.x-midX,y:p.y-midY}));
  let i1=-1,i2=-1,far=0,area=0;
  for(let i=1;i<n;i++){const d=(pts[i].x-pts[0].x)**2+(pts[i].y-pts[0].y)**2;if(d>far){far=d;i1=i}}
  if(i1<0)return [];
  for(let i=1;i<n;i++){const a=Math.abs(orient(pts[0],pts[i1],pts[i]));if(a>area){area=a;i2=i}}
  if(i2<0||area<=1e-12*far)return [];
  const [a0,b0,c0]=orient(pts[0],pts[i1],pts[i2])>0?[0,i1,i2]:[0,i2,i1];
  let triangles:Triangle[]=[{a:a0,b:b0,c:c0},{a:b0,b:a0,c:GHOST},{a:c0,b:b0,c:GHOST},{a:a0,b:c0,c:GHOST}];
  for(let i=1;i<n;i++){
    if(i===i1||i===i2)continue;
    const p=pts[i];
    const bad=new Set(triangles.filter(t=>conflicts(t,p,pts)));
    const edges=new Map<string,Edge>();
    for(const t of bad)for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]] as Array<[number,number]>){
      const k=edgeKey(a,b);if(edges.has(k))edges.delete(k);else edges.set(k,{a,b});
    }
    triangles=triangles.filter(t=>!bad.has(t));
    for(const e of edges.values())triangles.push(e.a===GHOST?{a:e.b,b:i,c:GHOST}:e.b===GHOST?{a:i,b:e.a,c:GHOST}:{a:e.a,b:e.b,c:i});
  }
  return triangles.filter(t=>t.c!==GHOST&&orient(pts[t.a],pts[t.b],pts[t.c])>0).map(({a,b,c})=>({a,b,c}));
}

export function triangleArea(p:XY[],t:Triangle){return ((p[t.b].x-p[t.a].x)*(p[t.c].y-p[t.a].y)-(p[t.b].y-p[t.a].y)*(p[t.c].x-p[t.a].x))/2}
// Edges used by exactly one triangle, oriented as in that (counter-clockwise) triangle: the TIN boundary.
export function boundaryEdges(triangles:Triangle[]):Array<[number,number]>{
  const seen=new Map<string,{a:number;b:number;count:number}>();
  for(const t of triangles)for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]] as Array<[number,number]>){
    const k=edgeKey(a,b),e=seen.get(k);
    if(e)e.count++;else seen.set(k,{a,b,count:1});
  }
  return [...seen.values()].filter(e=>e.count===1).map(e=>[e.a,e.b]);
}
export function uniqueEdges(triangles:Triangle[]):Array<[number,number]>{
  const seen=new Map<string,[number,number]>();
  for(const t of triangles)for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]] as Array<[number,number]>){
    const k=edgeKey(a,b);if(!seen.has(k))seen.set(k,[a,b]);
  }
  return [...seen.values()];
}
