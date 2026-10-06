import {describe,it,expect} from "vitest";
import {sectionSvg,sectionCsv} from "../src/sectionSvg";
import {computeSection} from "../src/section";
import {buildGeologicalModel} from "../src/model";
import {referenceProject,valleyProject} from "../src/geology";

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

  it("escapes names and never compresses the vertical scale below 1:1",()=>{
    const tall=buildGeologicalModel({...referenceProject,name:"Pit <A&B>"});
    const svg=sectionSvg(tall,computeSection(tall,{azimuth:90,offset:0}),{width:1200,height:300});
    expect(svg).toContain("Pit &lt;A&amp;B&gt;");
    expect(Number(svg.match(/V\.E\. ×([\d.]+)/)![1])).toBeGreaterThanOrEqual(1);
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
