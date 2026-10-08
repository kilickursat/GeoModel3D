import {describe,it,expect} from "vitest";
import {reportHtml} from "../src/report";
import {buildGeologicalModel} from "../src/model";
import {computeSection} from "../src/section";
import {sakaeProject,valleyProject,GeoProject} from "../src/geology";
import {sectionField} from "../src/fields";

const options={paper:"A3" as const,date:"2026-10-07",version:"0.6.1",credits:["Data KuniJiban"],notes:["A note <with> markup"],sectionBuffer:300,ve:5};

describe("printable report",()=>{
  const m=buildGeologicalModel(sakaeProject),s=computeSection(m,{azimuth:170,offset:0},300);
  it("carries the title block, units, interpretation rules, section, boreholes and notes",()=>{
    const html=reportHtml(m,s,{...options,image:"data:image/png;base64,AAAA"});
    expect(html).toContain("@page{size:A3 landscape");
    expect(html).toContain("<h1>Sakae, Yokohama (KuniJiban)</h1>");
    expect(html).toContain("JGD2011 / Japan Plane Rectangular CS IX (EPSG:6677)");
    for(const u of m.units)expect(html).toContain(u.name);
    expect(html).toContain("Units from logged descriptions (interpretation)");
    expect(html).toContain("≥ 50");
    expect(html).toContain("Section A–A′ · 170° · +0 m");
    expect(html.match(/<svg /g)!.length).toBe(1);
    for(const b of m.boreholes)expect(html).toContain(`<td>${b.id}</td>`);
    expect(html).toContain("A note &lt;with&gt; markup");
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html.match(/class="page"/g)!.length).toBe(3);
  });
  it("sizes the pages for A4, says when the 3-D view is missing, and names local coordinates",()=>{
    const v=buildGeologicalModel(valleyProject),html=reportHtml(v,computeSection(v,{azimuth:80,offset:0}),{...options,paper:"A4"});
    expect(html).toContain("@page{size:A4 landscape");
    expect(html).toContain("could not be captured");
    expect(html).toContain("Local grid (m) (not georeferenced)");
    expect(html).not.toContain("Units from logged descriptions");
  });
  it("tabulates the ground parameters and gives a shown field a page of its own",()=>{
    const f=sectionField(m,s,"s")!;
    const html=reportHtml(m,s,{...options,field:f});
    expect(html.match(/class="page"/g)!.length).toBe(4);
    expect(html.match(/<svg /g)!.length).toBe(2);
    expect(html).toContain("Section A–A′ · 170° · +0 m · Vertical effective stress σ′v");
    expect(html).toContain("<h2>Ground parameters</h2>");
    expect(html).toContain("N measured");
    expect(html).toMatch(/18 \/ 20 <span class="muted">assumed<\/span>/);
    expect(html).toMatch(/<th>Groundwater<\/th><td>Water levels logged in \d+ of 75 boreholes/);
    expect(html).toContain("Unit weights assumed (18 kN/m³ above and 20 kN/m³ below the water table)");
  });
  it("lists units hidden in the view in the notes",()=>{
    const v=buildGeologicalModel(valleyProject),html=reportHtml(v,computeSection(v,{azimuth:80,offset:0}),{...options,hidden:new Set(["Made Ground","Alluvium"])});
    expect(html).toContain("Hidden in the 3-D view and the section: Made Ground, Alluvium");
  });
  it("escapes names",()=>{
    const p:GeoProject={...valleyProject,name:"Site <b>&",units:valleyProject.units.map((u,k)=>k?u:{...u,name:"Fill <x>"})};
    const v=buildGeologicalModel(p),html=reportHtml(v,computeSection(v,{azimuth:80,offset:0}),options);
    expect(html).toContain("<h1>Site &lt;b&gt;&amp;</h1>");
    expect(html).toContain("Fill &lt;x&gt;");
    expect(html).not.toContain("<x>");
  });
});
