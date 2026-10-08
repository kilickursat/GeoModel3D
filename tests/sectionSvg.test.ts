import {describe,it,expect} from "vitest";
import {sectionSvg,sectionCsv} from "../src/sectionSvg";
import {computeSection} from "../src/section";
import {buildGeologicalModel} from "../src/model";
import {referenceProject,valleyProject,sakaeProject} from "../src/geology";

describe("section drawing",()=>{
  const m=buildGeologicalModel(valleyProject);
  const s=computeSection(m,{azimuth:90,offset:0},60);

  it("draws one polygon per unit present on the section and every projected borehole",()=>{
    const svg=sectionSvg(m,s,{width:1200,height:600,theme:"light",legend:true});
    expect(svg.startsWith("<svg")&&svg.endsWith("</svg>")).toBe(true);
    const present=m.units.filter((_,k)=>s.z[k].some((z,j)=>z-s.z[k+1][j]>1e-9));
    expect(svg.match(/<polygon /g)!.length).toBe(present.length);
    for(const p of s.boreholes)expect(svg).toContain(`>${m.boreholes[p.index].id}</text>`);
    expect(svg).toMatch(/stroke-dasharray/);
    expect(svg).toContain("Synthetic valley — Section A–A′ · azimuth 090° · offset +0 m");
  });

  it("leaves hidden units unfilled and out of the legend, but keeps them in the borehole logs",()=>{
    const all=sectionSvg(m,s,{width:1200,height:600,theme:"light",legend:true});
    const svg=sectionSvg(m,s,{width:1200,height:600,theme:"light",legend:true,hidden:new Set(["Made Ground"])});
    expect(svg.match(/<polygon /g)!.length).toBe(all.match(/<polygon /g)!.length-1);
    expect(svg).not.toContain("<title>Made Ground</title>");
    expect(svg).not.toContain(">Made Ground</text>");
    expect(svg.match(/fill="#9a5b4f"/g)!.length).toBeGreaterThan(0);
  });

  it("escapes names and never compresses the vertical scale below 1:1",()=>{
    const tall=buildGeologicalModel({...referenceProject,name:"Pit <A&B>"});
    const svg=sectionSvg(tall,computeSection(tall,{azimuth:90,offset:0}),{width:1200,height:300});
    expect(svg).toContain("Pit &lt;A&amp;B&gt;");
    expect(Number(svg.match(/V\.E\. ×([\d.]+)/)![1])).toBeGreaterThanOrEqual(1);
  });

  it("names crowded boreholes only where the names do not overlap, nearest the section first",()=>{
    const m=buildGeologicalModel(sakaeProject),s=computeSection(m,{azimuth:170,offset:0},300);
    const svg=sectionSvg(m,s,{width:640,height:330,buffer:300});
    const titles=svg.match(/<title>[^<]*of the section<\/title>/g)!.length,names=svg.match(/font-size="9\.5"/g)!.length;
    expect(titles).toBe(s.boreholes.length);
    expect(s.boreholes.length).toBeGreaterThan(20);
    expect(names).toBeGreaterThan(5);
    expect(names).toBeLessThan(titles);
    const nearest=[...s.boreholes].sort((p,q)=>Math.abs(p.offset)-Math.abs(q.offset))[0];
    expect(svg).toContain(`>${m.boreholes[nearest.index].id}</text>`);
  });

  it("can draw at a round vertical exaggeration",()=>{
    const m=buildGeologicalModel(sakaeProject),s=computeSection(m,{azimuth:170,offset:0},300);
    const fill=sectionSvg(m,s,{width:1600,height:900}).match(/V\.E\. ×([\d.]+)/)![1];
    const round=sectionSvg(m,s,{width:1600,height:900,roundVe:true}).match(/V\.E\. ×([\d.]+)/)![1];
    expect([1,2,2.5,5,10,20,25,50,100,200]).toContain(Number(round));
    expect(Number(round)).toBeLessThanOrEqual(Number(fill));
  });

  it("explains an empty section",()=>{
    const off=computeSection(m,{azimuth:90,offset:10000});
    expect(sectionSvg(m,off,{width:400,height:200})).toContain("does not cross the model footprint");
  });

  it("exports the section polylines as CSV",()=>{
    const rows=sectionCsv(m,s).trim().split("\n");
    expect(rows[0]).toBe("distance_m,x,y,"+m.horizons.map(h=>h.name+" z").join(","));
    expect(rows.length).toBe(s.s.length+1);
    expect(rows[1].split(",")[0]).toBe("0");
  });
});
