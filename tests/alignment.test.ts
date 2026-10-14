import {describe,it,expect} from "vitest";
import {alignmentSection,chainages,pointAt,nearestOnLine,designAt,chainageTable,crossSectionAt,alignmentProblem,outsideStretches,alignmentLength} from "../src/alignment";
import {buildGeologicalModel,sampleModel,modelBounds} from "../src/model";
import {computeSection,sectionFrame,sectionRuns} from "../src/section";
import {columnAt} from "../src/fields";
import {valleyProject,referenceProject,channelProject,Alignment} from "../src/geology";

describe("sections along an alignment",()=>{
  const valley=buildGeologicalModel(valleyProject);

  it("give exactly the straight section along a straight line",()=>{
    const spec={azimuth:77,offset:13.37},straight=computeSection(valley,spec,60);
    const {origin,dir}=sectionFrame(valley,spec),R=5000;
    const line:Alignment={name:"straight",start:-R,points:[{x:origin.x-dir.x*R,y:origin.y-dir.y*R},{x:origin.x+dir.x*R,y:origin.y+dir.y*R}]};
    const along=alignmentSection(valley,line,60);
    expect(along.s.length).toBe(straight.s.length);
    along.s.forEach((s,j)=>expect(s).toBeCloseTo(straight.s[j],6));
    along.z.forEach((z,k)=>z.forEach((v,j)=>expect(v).toBeCloseTo(straight.z[k][j],9)));
    expect(along.observed).toEqual(straight.observed);
    expect(along.water?.length).toBe(straight.water?.length);
    along.water?.forEach((w,j)=>expect(w).toBeCloseTo(straight.water![j],9));
    expect(along.boreholes.map(b=>b.index)).toEqual(straight.boreholes.map(b=>b.index));
    along.boreholes.forEach((b,i)=>{
      expect(b.s).toBeCloseTo(straight.boreholes[i].s,6);
      expect(b.offset).toBeCloseTo(straight.boreholes[i].offset,6);
    });
    expect(sectionRuns(along)).toEqual([[0,along.s.length-1]]);
  });

  it("follow a bent line exactly, with a sample at the bend",()=>{
    const b=modelBounds(valley),w=b.maxX-b.minX,h=b.maxY-b.minY;
    const line:Alignment={name:"bent",start:1000,points:[{x:b.minX+0.1*w,y:b.minY+0.2*h},{x:b.minX+0.55*w,y:b.minY+0.75*h},{x:b.minX+0.9*w,y:b.minY+0.35*h}]};
    const s=alignmentSection(valley,line),ch=chainages(line);
    expect(ch[0]).toBe(1000);
    expect(ch[2]).toBeCloseTo(1000+alignmentLength(line),9);
    expect(s.s[0]).toBeCloseTo(1000,9);
    expect(s.s.some(c=>Math.abs(c-ch[1])<1e-9)).toBe(true);
    for(let j=1;j<s.s.length;j++)expect(s.s[j]).toBeGreaterThan(s.s[j-1]);
    // Between samples the horizons are linear, so the section is the model at every chainage.
    for(let i=0;i<=60;i++){
      const c=ch[0]+(ch[2]-ch[0])*i/60,p=pointAt(line,c),col=columnAt(s,c)!,model=sampleModel(valley,p.x,p.y)!;
      expect(col.x).toBeCloseTo(p.x,6);
      expect(col.y).toBeCloseTo(p.y,6);
      col.z.forEach((z,k)=>expect(z).toBeCloseTo(model[k],6));
    }
  });

  it("use the chainages given at the points, linearly between them",()=>{
    const line:Alignment={name:"given",points:[{x:0,y:10,chainage:2000},{x:60,y:10,chainage:2100},{x:60,y:70,chainage:2160}]};
    expect(chainages(line)).toEqual([2000,2100,2160]);
    const half=pointAt(line,2050);
    expect(half.x).toBeCloseTo(30,9);
    expect(half.y).toBeCloseTo(10,9);
    const corner=pointAt(line,2100);
    expect(corner.dir.x).toBeCloseTo(Math.SQRT1_2,9);
    expect(corner.dir.y).toBeCloseTo(Math.SQRT1_2,9);
    const s=alignmentSection(buildGeologicalModel(referenceProject),line);
    expect(s.s.some(c=>Math.abs(c-2100)<1e-9)).toBe(true);
    expect(s.s[s.s.length-1]).toBeLessThanOrEqual(2160+1e-9);
  });

  it("break where the line leaves the model and comes back",()=>{
    const ref=buildGeologicalModel(referenceProject);
    const line:Alignment={name:"loop",points:[{x:30,y:40},{x:-50,y:40},{x:-50,y:60},{x:30,y:60}]};
    const s=alignmentSection(ref,line),runs=sectionRuns(s);
    expect(runs.length).toBe(2);
    const gap=outsideStretches(s);
    expect(gap.length).toBe(1);
    const mid=(gap[0][0]+gap[0][1])/2;
    expect(columnAt(s,mid)).toBeNull();
    expect(columnAt(s,s.s[runs[0][1]])).not.toBeNull();
    expect(chainageTable(ref,s,5).every(r=>r.chainage<=gap[0][0]+1e-9||r.chainage>=gap[0][1]-1e-9)).toBe(true);
  });

  it("project the boreholes beside the line, to the right positive, and leave out those beyond its ends",()=>{
    const ref=buildGeologicalModel(referenceProject);
    const line:Alignment={name:"east",points:[{x:10,y:38},{x:100,y:38}]};
    expect(nearestOnLine(line,{x:80,y:4})).toMatchObject({chainage:70,offset:34,beyond:false});
    expect(nearestOnLine(line,{x:0,y:0}).beyond).toBe(true);
    const ids=alignmentSection(ref,line,40).boreholes.map(b=>ref.boreholes[b.index].id);
    expect(ids).toEqual(["BH-005","BH-004","BH-002"]);
  });

  it("interpolate the design levels and give none beyond them",()=>{
    const design=[{chainage:100,top:20,bottom:14},{chainage:200,top:10,bottom:4},{chainage:300,top:12}];
    expect(designAt(design,150)).toEqual({top:15,bottom:9});
    expect(designAt(design,250)).toEqual({top:11});
    expect(designAt(design,99)).toEqual({});
    expect(designAt(design,301)).toEqual({});
    expect(designAt([{chainage:5,top:1}],5)).toEqual({top:1});
  });

  it("tabulate the ground, the cover and the units at the design levels by chainage",()=>{
    const channel=buildGeologicalModel(channelProject);
    const line:Alignment={name:"tunnel",points:[{x:40,y:150},{x:320,y:100}],design:[{chainage:0,top:20,bottom:13.5},{chainage:285,top:12,bottom:5.5}]};
    const s=alignmentSection(channel,line),rows=chainageTable(channel,s,10);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every(r=>Math.abs(r.chainage/10-Math.round(r.chainage/10))<1e-9)).toBe(true);
    for(const r of rows){
      const z=sampleModel(channel,r.x,r.y)!;
      expect(r.ground).toBeCloseTo(z[0],6);
      r.thickness.forEach((t,k)=>expect(t).toBeCloseTo(Math.max(0,z[k]-z[k+1]),6));
      const d=designAt(line.design,r.chainage);
      expect(r.top).toBeCloseTo(d.top!,9);
      // The unit at the crown holds it; inside the model the shares of the tunnel height add up to one.
      const k=r.unitTop!;
      if(k>=0)expect(d.top!).toBeLessThanOrEqual(z[k]+1e-9);
      if(k>=0)expect(d.top!).toBeGreaterThanOrEqual(z[k+1]-1e-9);
      if(d.top!<=z[0]&&d.bottom!>=z[z.length-1])expect(r.share!.reduce((a,b)=>a+b,0)).toBeCloseTo(1,9);
    }
    expect(rows.some(r=>channel.units[r.unitTop!]?.id==="Channel Gravel")).toBe(true);
  });

  it("cross the line square to it at a chainage",()=>{
    const line:Alignment={name:"diagonal",points:[{x:0,y:0},{x:60,y:60}]};
    const ref=buildGeologicalModel(referenceProject),c=crossSectionAt(ref,line,40);
    expect(c.azimuth).toBe(135);
    const {origin,normal}=sectionFrame(ref,{azimuth:c.azimuth,offset:c.offset});
    expect((c.x-origin.x)*normal.x+(c.y-origin.y)*normal.y).toBeCloseTo(0,9);
  });

  it("say what is wrong with an alignment",()=>{
    expect(alignmentProblem({name:"a",points:[{x:0,y:0}]})).toMatch(/two points/);
    expect(alignmentProblem({name:"a",points:[{x:0,y:0},{x:0,y:0}]})).toMatch(/same place/);
    expect(alignmentProblem({name:"a",points:[{x:0,y:0,chainage:10},{x:5,y:0}]})).toMatch(/not at all/);
    expect(alignmentProblem({name:"a",points:[{x:0,y:0,chainage:10},{x:5,y:0,chainage:10}]})).toMatch(/does not increase/);
    expect(alignmentProblem({name:"a",points:[{x:0,y:0},{x:5,y:0}],design:[{chainage:0,top:1,bottom:2}]})).toMatch(/crown/);
    expect(alignmentProblem({name:"a",points:[{x:0,y:0},{x:5,y:0}],design:[{chainage:0,top:3,bottom:2}]})).toBeNull();
  });
});

describe("the profile along a line",()=>{
  const channel=buildGeologicalModel(channelProject),tunnel=channelProject.alignments![0];
  const s=alignmentSection(channel,tunnel,40);

  it("is drawn by chainage, with the tunnel from crown to invert, the bends and a marker",async()=>{
    const {sectionSvg,sectionCsv,chainageCsv}=await import("../src/sectionSvg");
    const svg=sectionSvg(channel,s,{width:1200,height:600,theme:"light",legend:true,marker:1176});
    expect(svg).toContain("Profile along Synthetic tunnel · chainage 1000–1286.09 m");
    expect(svg).toContain("Chainage (m)");
    expect(svg).toContain("<title>Design: crown to invert</title>");
    expect(svg).toContain(">Design: crown to invert</text>");
    expect(svg.match(/Bend of the line/g)!.length).toBe(2);
    expect(svg).toContain(">1176</text>");
    expect(svg).not.toContain("A′");
    const csv=sectionCsv(channel,s).trim().split("\n");
    expect(csv[0].startsWith("chainage_m,x,y,")).toBe(true);
    expect(Number(csv[1].split(",")[0])).toBeGreaterThanOrEqual(1000);
    const table=chainageCsv(channel,s,10).trim().split("\n"),head=table[0].split(",");
    expect(head.slice(0,9)).toEqual(["chainage_m","x","y","ground_m","crown_m","invert_m","cover_above_crown_m","unit_at_crown","unit_at_invert"]);
    expect(table.length-1).toBe(chainageTable(channel,s,10).length);
    const row=table.find(r=>r.startsWith("1170,"))!.split(","),share=head.map((h,i)=>h.endsWith("share_%")?Number(row[i]):0).reduce((a,b)=>a+b,0);
    expect(share).toBeCloseTo(100,0);
    expect(row[head.indexOf("unit_at_crown")]).toBe("Channel Gravel");
  });

  it("gets a page by chainage in the report, and says where the line is outside the model",async()=>{
    const {reportHtml}=await import("../src/report");
    const html=reportHtml(channel,s,{paper:"A3",date:"2026-10-14",version:"0.13.0",credits:[],notes:[],sectionBuffer:40,ve:2,chainageStep:10});
    expect(html).toContain("<h2>Profile along Synthetic tunnel · chainage 1000–1286.09 m</h2>");
    expect(html).toContain("<h2>Synthetic tunnel: by chainage</h2>");
    expect(html).toContain("<th>Cover above crown (m)</th>");
    expect(html).toMatch(/Chainage 1,000–1,00\d m lies outside the model/);
    expect(html.match(/class="page"/g)!.length).toBe(4);
  });
});

describe("lines across a straight section",()=>{
  const channel=buildGeologicalModel(channelProject),tunnel=channelProject.alignments![0];
  it("are found where the section crosses them, with the design levels there",async()=>{
    const c=crossSectionAt(channel,tunnel,1176),s=computeSection(channel,{azimuth:c.azimuth,offset:c.offset},40);
    const {lineCrossings}=await import("../src/alignment");
    const found=lineCrossings(s,[tunnel]);
    expect(found.length).toBe(1);
    expect(found[0].chainage).toBeCloseTo(1176,0);
    expect(Math.hypot(found[0].x-c.x,found[0].y-c.y)).toBeLessThan(1);
    const d=designAt(tunnel.design,found[0].chainage);
    expect(found[0].top).toBeCloseTo(d.top!,9);
    expect(found[0].bottom).toBeCloseTo(d.bottom!,9);
    expect(lineCrossings(alignmentSection(channel,tunnel),[tunnel])).toEqual([]);
    const {sectionSvg}=await import("../src/sectionSvg");
    const svg=sectionSvg(channel,s,{width:900,height:500,crossings:found});
    expect(svg).toMatch(/<title>Synthetic tunnel at chainage 117\d(\.\d+)? m: crown [\d.]+ m, invert [\d.]+ m<\/title>/);
    const {reportHtml}=await import("../src/report");
    expect(reportHtml(channel,s,{paper:"A4",date:"2026-10-14",version:"0.14.0",credits:[],notes:[],sectionBuffer:40,ve:2})).toContain(">Synthetic tunnel<title>");
  });
});
