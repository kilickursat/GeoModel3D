import {describe,it,expect} from "vitest";
import {buildGeologicalModel,boreholeContacts,subdivide,sampleModel,unitCubicMetres,unitVolume,modelBounds,GeoModel} from "../src/model";
import {volumeGeometry} from "../src/volume";
import {computeSection,offsetRange} from "../src/section";
import {valleyProject,channelProject,GeoProject,UnitDef,boreholeDepth} from "../src/geology";
import {terrainZ,TerrainGrid} from "../src/terrain";
import {delaunay,triangleArea,boundaryEdges,uniqueEdges} from "../src/tin";
import {randomPoints,meshVolume,openEdges,latticeNodeCount} from "./helpers";
import truth from "./fixtures/channel-truth.json";

const ordered=(m:GeoModel)=>m.horizons.every((h,k)=>k===0||h.z.every((z,i)=>z<=m.horizons[k-1].z[i]+1e-9));

describe("subdividing the borehole triangulation",()=>{
  const pts=randomPoints(25,3),tris=delaunay(pts);
  it("keeps the original triangles at level 1",()=>{
    const s=subdivide(pts,tris,1);
    expect(s.triangles).toEqual(tris);
    expect(s.nodes.length).toBe(pts.length);
  });
  it("splits each triangle into level² counter-clockwise triangles that still tile the hull without gaps",()=>{
    const L=4,s=subdivide(pts,tris,L);
    expect(s.triangles.length).toBe(tris.length*L*L);
    for(const t of s.triangles)expect(triangleArea(s.nodes,t)).toBeGreaterThan(0);
    expect(s.triangles.reduce((a,t)=>a+triangleArea(s.nodes,t),0)).toBeCloseTo(tris.reduce((a,t)=>a+triangleArea(pts,t),0),6);
    expect(boundaryEdges(s.triangles).length).toBe(boundaryEdges(tris).length*L);
    expect(s.edgeChains.length).toBe(uniqueEdges(tris).length);
    expect(s.edgeChains.every(c=>c.length===L+1)).toBe(true);
  });
});

describe("terrain",()=>{
  const m=buildGeologicalModel(valleyProject),t=valleyProject.terrain!;
  it("subdivides the model and keeps every collar at its surveyed elevation",()=>{
    expect(m.level).toBeGreaterThan(1);
    expect(m.warnings).toEqual([]);
    m.boreholes.forEach((b,i)=>expect(m.horizons[0].z[i]).toBe(b.z));
    expect(Math.max(...m.residuals.map(r=>Math.abs(r.residual)))).toBeLessThan(0.6);
  });
  it("follows the terrain between boreholes, corrected only by the collar residuals",()=>{
    const worst=Math.max(...m.residuals.map(r=>Math.abs(r.residual)));
    for(let n=m.boreholes.length;n<latticeNodeCount(m);n+=37)
      expect(Math.abs(m.horizons[0].z[n]-terrainZ(t,m.nodes[n].x,m.nodes[n].y))).toBeLessThanOrEqual(worst+1e-9);
  });
  it("keeps every horizon at or below the ground and the volumes closed",()=>{
    expect(ordered(m)).toBe(true);
    const b=modelBounds(m),origin={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2,z:(b.minZ+b.maxZ)/2};
    m.units.forEach((_,u)=>{
      const g=volumeGeometry(unitVolume(m,u),origin);
      expect(openEdges(g.indices)).toEqual([]);
      expect(Math.abs(meshVolume(g.positions,g.indices)-unitCubicMetres(m,u))/unitCubicMetres(m,u)).toBeLessThan(1e-4);
    });
  });
  it("removes the top unit where the terrain cuts below its base",()=>{
    const units:UnitDef[]=[{id:"Fill",name:"Fill",color:"#777777"},{id:"Rock",name:"Rock",color:"#888888"}];
    const log=[{from:0,to:4,unit:"Fill"},{from:4,to:20,unit:"Rock"}];
    const holes=[[0,0],[100,0],[0,100],[100,100]].map(([x,y],i)=>({id:"H"+i,x,y,z:50,intervals:log}));
    const z:number[]=[];
    for(let r=0;r<21;r++)for(let c=0;c<21;c++){const x=c*5,y=r*5;z.push(50-8*Math.exp(-(((x-50)/12)**2)))}
    const terrain:TerrainGrid={x0:0,y0:0,dx:5,dy:5,ncols:21,nrows:21,z};
    const flat=buildGeologicalModel({name:"flat",units,boreholes:holes}),cut=buildGeologicalModel({name:"cut",units,boreholes:holes,terrain});
    const s=sampleModel(cut,50,50)!;
    expect(s[0]).toBeCloseTo(42,1);
    expect(s[1]).toBeCloseTo(s[0],9);
    expect(unitCubicMetres(cut,0)).toBeLessThan(unitCubicMetres(flat,0)*0.85);
    expect(ordered(cut)).toBe(true);
  });
  it("runs pinch-outs straight across triangles, exactly where the ground meets the unit's base",()=>{
    const units:UnitDef[]=[{id:"Fill",name:"Fill",color:"#777777"},{id:"Rock",name:"Rock",color:"#888888"}];
    const log=[{from:0,to:4,unit:"Fill"},{from:4,to:20,unit:"Rock"}];
    const holes=[[0,0],[100,0],[0,100],[100,100]].map(([x,y],i)=>({id:"H"+i,x,y,z:50,intervals:log}));
    const z:number[]=[];
    for(let r=0;r<21;r++)for(let c=0;c<21;c++){const x=c*5,y=r*5;z.push(50-8*Math.exp(-(((x-50)/12)**2+((y-50)/30)**2)))}
    const m=buildGeologicalModel({name:"cut",units,boreholes:holes,terrain:{x0:0,y0:0,dx:5,dy:5,ncols:21,nrows:21,z}});
    // The base of the fill is 46 m everywhere; the ground dips below it in the trench.
    let crossings=0;
    for(let x=1;x<100;x+=0.37)for(const y of [23.3,50,61.9]){
      const s=sampleModel(m,x,y)!;
      expect(s[1]).toBeCloseTo(Math.min(46,s[0]),9);
      if(s[0]<46)crossings++;
    }
    expect(crossings).toBeGreaterThan(20);
    // The mesh still tiles the footprint with counter-clockwise triangles, and the horizon lines follow its edges.
    expect(m.triangles.reduce((a,t)=>a+triangleArea(m.nodes,t),0)).toBeCloseTo(100*100,6);
    for(const t of m.triangles)expect(triangleArea(m.nodes,t)).toBeGreaterThanOrEqual(0);
    const edges=new Set(uniqueEdges(m.triangles).map(([a,b])=>Math.min(a,b)+":"+Math.max(a,b)));
    for(const c of m.edgeChains)for(let j=1;j<c.length;j++)expect(edges.has(Math.min(c[j-1],c[j])+":"+Math.max(c[j-1],c[j]))).toBe(true);
  });

  it("gives terrain above the collar surface to the unit at the surface, never to a unit the boreholes lack there",()=>{
    const units:UnitDef[]=["Fill","Clay","Rock"].map(id=>({id,name:id,color:"#888888"}));
    const plain=[{from:0,to:5,unit:"Clay"},{from:5,to:20,unit:"Rock"}];
    const holes=[[0,0],[100,0],[0,100],[100,100]].map(([x,y],i)=>({id:"H"+i,x,y,z:50,intervals:plain}));
    holes.push({id:"F",x:200,y:50,z:50,intervals:[{from:0,to:2,unit:"Fill"},{from:2,to:7,unit:"Clay"},{from:7,to:20,unit:"Rock"}]});
    const z:number[]=[];
    for(let r=0;r<21;r++)for(let c=0;c<41;c++){const x=c*5,y=r*5;z.push(50+3*Math.exp(-((x-50)**2+(y-50)**2)/20**2))}
    const m=buildGeologicalModel({name:"hump",units,boreholes:holes,terrain:{x0:0,y0:0,dx:5,dy:5,ncols:41,nrows:21,z}});
    const s=sampleModel(m,50,50)!;
    expect(s[0]).toBeGreaterThan(52.5);
    expect(s[0]-s[1]).toBeLessThan(1e-9);
    expect(s[2]).toBeCloseTo(45,9);
    for(let x=2;x<100;x+=7)for(let y=2;y<100;y+=7){const v=sampleModel(m,x,y)!;expect(v[0]-v[1]).toBeLessThan(1e-9)}
    expect(ordered(m)).toBe(true);
  });

  it("reports collars that disagree with the terrain and still honours them",()=>{
    const p:GeoProject={...valleyProject,boreholes:valleyProject.boreholes.map(b=>b.id==="BH-07"?{...b,z:b.z+3}:b)};
    const m2=buildGeologicalModel(p);
    expect(m2.warnings.join("\n")).toMatch(/BH-07: collar .* terrain adjusted to the collar/);
    const i=m2.boreholes.findIndex(b=>b.id==="BH-07");
    expect(m2.horizons[0].z[i]).toBe(p.boreholes.find(b=>b.id==="BH-07")!.z);
  });
});

describe("erosional units",()=>{
  const units:UnitDef[]=["A","E","B","C"].map(id=>({id,name:id,color:"#888888",erosive:id==="E"}));
  const hole=(intervals:Array<[number,number,string]>)=>({id:"H",x:0,y:0,z:100,intervals:intervals.map(([from,to,unit])=>({from,to,unit}))});

  it("treats units missing under an erosive unit as eroded, not thinned",()=>{
    const c=boreholeContacts(hole([[0,2,"A"],[2,9,"E"],[9,15,"C"]]),units);
    expect(c.depth).toEqual([0,2,9,null,null]);
    expect(c.eroded).toEqual([null,null,null,9,null]);
    const conformable=boreholeContacts(hole([[0,2,"A"],[2,9,"E"],[9,15,"C"]]),units.map(u=>({...u,erosive:false})));
    expect(conformable.depth).toEqual([0,2,9,9,null]);
  });

  it("reproduces the buried channel's truncated layers far better than thinning them",()=>{
    const ids=(m:GeoModel)=>m.horizons.map(h=>h.id);
    const rms=(m:GeoModel,id:string)=>{
      const k=ids(m).indexOf(id),vals=(truth.horizons as Record<string,number[]>)[id];
      let s=0,n=0;
      for(let r=0;r<truth.nrows;r++)for(let c=0;c<truth.ncols;c++){
        const v=sampleModel(m,c*truth.d,r*truth.d);
        if(v){s+=(v[k]-vals[r*truth.ncols+c])**2;n++}
      }
      return Math.sqrt(s/n);
    };
    const erosive=buildGeologicalModel(channelProject);
    const conformable=buildGeologicalModel({...channelProject,units:channelProject.units.map(u=>({...u,erosive:false}))});
    expect(erosive.warnings).toEqual([]);
    expect(ordered(erosive)).toBe(true);
    for(const [id,ratio] of [["base:Mudstone",0.7],["base:Sandstone",0.5],["base:Siltstone",0.5]] as Array<[string,number]>)
      expect(rms(erosive,id)).toBeLessThan(rms(conformable,id)*ratio);
    expect(rms(erosive,"base:Mudstone")).toBeLessThan(0.8);
  });

  it("honours every log under the channel",()=>{
    const m=buildGeologicalModel(channelProject);
    m.boreholes.forEach((b,i)=>{
      for(const iv of b.intervals){
        const u=m.units.findIndex(x=>x.id===iv.unit);
        expect(m.horizons[u].z[i]).toBeCloseTo(b.z-iv.from,9);
        if(iv.to<boreholeDepth(b))expect(m.horizons[u+1].z[i]).toBeCloseTo(b.z-iv.to,9);
      }
    });
  });

  it("keeps section polygons non-negative across the channel",()=>{
    const m=buildGeologicalModel(channelProject);
    for(let az=0;az<180;az+=30){
      const [lo,hi]=offsetRange(m,az);
      const s=computeSection(m,{azimuth:az,offset:(lo+hi)/2});
      for(let k=1;k<s.z.length;k++)s.z[k].forEach((z,j)=>expect(z).toBeLessThanOrEqual(s.z[k-1][j]+1e-9));
    }
  });
});
