import {describe,it,expect} from "vitest";
import {Cpt,GeoProject} from "../src/schema";
import {groundwaterAt,groundwaterSummary,parseGroundwater,selectedGroundwater} from "../src/groundwater";
import {buildGeologicalModel} from "../src/model";
import {classifiedLayers,cptBehaviour,refreshAutomaticCptLayers,waterTableAt} from "../src/sbt";
import {classifyCpts,importFiles,toProjectJson} from "../src/io";
import {projectFromTables,tablesFromProject} from "../src/tables";
import {sampleProjects} from "../src/geology";
import {computeSection} from "../src/section";
import {availableFields,sectionField,propertySamples} from "../src/fields";
import {sectionSvg} from "../src/sectionSvg";
import {reportHtml} from "../src/report";

function project():GeoProject{
  return {name:"Water scenario",base:-5,units:[{id:"A",name:"A",color:"#aabbcc"},{id:"B",name:"B",color:"#ccbbaa"}],
    boreholes:[[0,0],[40,0],[0,40]].map(([x,y],i)=>({id:`B${i}`,x,y,z:10,intervals:[{from:0,to:2,unit:"A"},{from:2,to:10,unit:"B"}],
      water:[{depth:2,date:"2026-01-01"},{depth:5,date:"2026-06-01"},{depth:1,date:"2027-01-01"},{depth:3}]}))};
}
function cpt(source?:"automatic"|"reviewed"):Cpt{
  const depth=Array.from({length:101},(_,i)=>i/10);
  return {id:"C",x:10,y:10,z:10,depth,qc:depth.map(()=>1),fs:depth.map(()=>25),layers:[{from:0,to:10,unit:"A",name:"Fixed interpretation",evidenceId:"source-layer"}],...(source?{layersSource:source}:{})};
}

describe("groundwater scenarios",()=>{
  it("retains the legacy shallowest, inverse-square interpolation and ground clipping",()=>{
    const p=project();p.boreholes=p.boreholes.slice(0,2);p.boreholes[1].z=12;
    expect(groundwaterAt(p,20,0,20)).toBe(10);
    expect(groundwaterAt(p,0,0,20)).toBe(9);
    expect(groundwaterAt(p,20,0,8)).toBe(8);
    p.boreholes.forEach(b=>delete b.water);p.groundwaterDepth=4;
    expect(groundwaterAt(p,0,0,10)).toBe(6);
    expect(groundwaterSummary(p)).toContain("no water level is logged");
  });

  it("lets an explicit assumed depth override measured water and legacy defaults",()=>{
    const p=project();p.groundwaterDepth=7;p.groundwater={mode:"assumed-depth",depth:4};
    expect(groundwaterAt(p,0,0,10)).toBe(6);
    expect(waterTableAt(p,20,0,12)).toBe(8);
    expect(selectedGroundwater(p)).toEqual([]);
    expect(groundwaterSummary(p)).toContain("explicit scenario override");
    const m=buildGeologicalModel(p);
    expect(m.water!.z).toEqual(Float64Array.from(m.horizons[0].z,g=>g-4));
  });

  it("takes the latest eligible dated reading, excludes future data and requires explicit undated fallback",()=>{
    const p=project();p.groundwaterDepth=9;p.groundwater={mode:"as-of",date:"2026-11-14"};
    expect(selectedGroundwater(p).map(r=>r.observation.depth)).toEqual([5,5,5]);
    expect(groundwaterAt(p,0,0,10)).toBe(5);
    p.groundwater.date="2025-01-01";
    expect(groundwaterAt(p,0,0,10)).toBeUndefined();
    expect(buildGeologicalModel(p).water).toBeUndefined();
    expect(groundwaterSummary(p)).toMatch(/unavailable.*legacy assumed depth is not used/);
    p.groundwater.includeUndated=true;
    expect(selectedGroundwater(p).every(r=>r.undatedFallback)).toBe(true);
    expect(groundwaterAt(p,0,0,10)).toBe(7);
    p.groundwater.date="2026-11-14";
    expect(selectedGroundwater(p).every(r=>!r.undatedFallback)).toBe(true);
    expect(groundwaterAt(p,0,0,10)).toBe(5);
  });

  it("includes the whole UTC date but honours exact timestamp cutoffs and rejects invalid observation dates",()=>{
    const p=project();p.boreholes=p.boreholes.slice(0,1);
    p.boreholes[0].water=[{depth:4,date:"2026-11-14T23:59:59Z"},{depth:8,date:"2026-11-14T12:00:00Z"},
      {depth:1,date:"2026-02-30"},{depth:2,date:"not a date"},{depth:6}];
    p.groundwater={mode:"as-of",date:"2026-11-14"};
    expect(groundwaterAt(p,0,0,10)).toBe(6);
    p.groundwater.date="2026-11-14T12:00:00Z";
    expect(groundwaterAt(p,0,0,10)).toBe(2);
    p.groundwater.date="2026-11-14T11:59:59Z";
    expect(groundwaterAt(p,0,0,10)).toBeUndefined();
    p.groundwater.includeUndated=true;
    expect(groundwaterAt(p,0,0,10)).toBe(4);
  });

  it("validates policy shape without coercion or impossible dates",()=>{
    for(const bad of [null,[],{mode:"unknown"},{mode:"observed",depth:2},{mode:"assumed-depth",depth:"2"},
      {mode:"assumed-depth",depth:Infinity},{mode:"as-of",date:"2026-02-30"},{mode:"as-of",date:"yesterday"},
      {mode:"as-of",date:"2026-11-14",includeUndated:"false"}])expect(()=>parseGroundwater(bad)).toThrow();
    expect(parseGroundwater({mode:"assumed-depth",depth:-1})).toEqual({mode:"assumed-depth",depth:-1});
    expect(parseGroundwater({mode:"as-of",date:"2026-11-14",includeUndated:false})).toEqual({mode:"as-of",date:"2026-11-14",includeUndated:false});
  });

  it("uses only the model's included boreholes when building water nodes",()=>{
    const p=project();p.boreholes.push({id:"Unlogged",x:10,y:10,z:100,intervals:[],water:[{depth:0}]});
    const m=buildGeologicalModel(p);
    expect(m.boreholes).toHaveLength(3);
    expect([...m.water!.z]).toEqual([...m.water!.z].map(()=>9));
  });

  it("matches the legacy water arithmetic across all seven bundled sites",()=>{
    for(const p of sampleProjects){
      const readings=p.boreholes.filter(b=>b.water?.length&&[b.x,b.y,b.z].every(Number.isFinite));
      for(const [x,y,g] of [[0,0,100],...p.boreholes.slice(0,3).map(b=>[b.x,b.y,b.z])]){
        let num=0,den=0,exact:number|undefined;
        for(const b of readings){
          const v=b.z-Math.min(...b.water!.map(w=>w.depth)),d2=(b.x-x)**2+(b.y-y)**2;
          if(d2<1e-12){exact=v;break}num+=v/d2;den+=1/d2;
        }
        const old=exact!==undefined||den>0?Math.min(exact??num/den,g):p.groundwaterDepth!==undefined?g-p.groundwaterDepth:undefined;
        expect(groundwaterAt(p,x,y,g),p.name).toBe(old);
        expect(groundwaterAt({...p,groundwater:{mode:"observed"}},x,y,g),p.name).toBe(old);
      }
    }
  });
});

describe("groundwater and CPT interpretations",()=>{
  it("blocks automatic geology when an as-of scenario has no eligible water instead of classifying dry",()=>{
    const p=project();p.cpts=[cpt("automatic")];p.cptLayers=true;p.groundwaterDepth=0;
    p.groundwater={mode:"as-of",date:"2025-01-01"};
    const before=structuredClone(p);
    expect(()=>buildGeologicalModel(p)).toThrow(/No eligible groundwater.*automatic CPT classification is unavailable/);
    expect(()=>classifiedLayers(p,p.cpts![0])).toThrow(/No eligible groundwater/);
    expect(p).toEqual(before);
    // A deliberately permitted undated observation, or an explicit assumption, makes classification possible.
    p.groundwater.includeUndated=true;
    expect(()=>buildGeologicalModel(p)).not.toThrow();
    p.groundwater={mode:"assumed-depth",depth:0};
    expect(()=>buildGeologicalModel(p)).not.toThrow();
  });

  it("keeps fixed logs and raw CPT readings but leaves unknown as-of stresses and SBT unavailable",()=>{
    const p=project(),c=cpt("reviewed");p.cpts=[c];p.cptLayers=true;
    for(const b of p.boreholes)delete b.water;
    // Prime the legacy undefined-water cache before changing policy without changing any data identity.
    expect(cptBehaviour(p,c).u0.every(v=>v===0)).toBe(true);
    p.groundwater={mode:"as-of",date:"2025-01-01"};
    const m=buildGeologicalModel(p),s=computeSection(m,{azimuth:0,offset:0},100),b=cptBehaviour(p,c);
    expect(m.cptLogs[0].intervals).toEqual(c.layers);
    for(const key of ["sv","u0","s","n","Qtn","Fr","ic","zone"] as const)expect(b[key].every(Number.isNaN)).toBe(true);
    expect(b.qt).toEqual(c.qc);expect(b.notes.join(" ")).toMatch(/No eligible groundwater.*unavailable/);
    expect(b.notes.join(" ")).not.toMatch(/no pore pressure in place/);
    const keys=availableFields(m).map(f=>f.key);
    for(const key of ["sv","u","s","sh","Ic"])expect(keys).not.toContain(key);
    expect(keys).toContain("qc");
    for(const key of ["sv","u","s","sh"])expect(sectionField(m,s,key)).toBeNull();
    expect(propertySamples(m,"Ic").flat()).toEqual([]);
    const html=reportHtml(m,s,{paper:"A3",date:"2026-11-14",version:"test",credits:[],notes:[],sectionBuffer:100,ve:1});
    expect(html).toContain("Groundwater unavailable as of 2025-01-01");
    expect(html).toContain("stresses and soil behaviour type are unavailable");
    expect(html).toContain("Shallowest logged water (all dates, m deep)");
    expect(html).not.toContain("NaN");
    delete p.groundwater;
    expect(cptBehaviour(p,c).u0.every(v=>v===0)).toBe(true);
  });

  it("draws only selected water observations and no observation markers for explicit assumptions",()=>{
    const p=project();p.groundwater={mode:"as-of",date:"2025-01-01"};
    const draw=()=>{const m=buildGeologicalModel(p);return sectionSvg(m,computeSection(m,{azimuth:0,offset:0},100),{width:900,height:500})};
    expect(draw()).not.toContain('class="water-observation"');
    p.groundwater.date="2026-11-14";
    const selected=draw();
    expect(selected).toContain('class="water-observation"');
    expect(selected).toContain("selected water observation 5 m below collar on 2026-06-01");
    expect(selected).not.toContain("2027-01-01");
    p.groundwater={mode:"assumed-depth",depth:4};
    expect(draw()).not.toContain('class="water-observation"');
    expect(draw()).toContain("<title>Water table</title>");
  });

  it("invalidates behaviour cached under an in-place water or policy edit",()=>{
    const p=project(),c=cpt(),before=cptBehaviour(p,c);
    expect(cptBehaviour(p,c)).toBe(before);
    p.groundwater={mode:"assumed-depth",depth:8};
    const dry=cptBehaviour(p,c);expect(dry).not.toBe(before);expect(dry.u0[50]).toBe(0);
    p.groundwater.depth=0;
    expect(cptBehaviour(p,c).u0[50]).toBe(5*9.81);
    delete p.groundwater;
    for(const b of p.boreholes)b.water=[{depth:6}];
    expect(cptBehaviour(p,c).u0[50]).toBe(0);
    for(const b of p.boreholes)b.water![0].depth=0;
    expect(cptBehaviour(p,c).u0[50]).toBe(5*9.81);
  });

  it("regenerates only automatic layers on water/rule changes and never mutates saved layers",()=>{
    const p=project(),automatic=cpt("automatic"),reviewed={...cpt("reviewed"),id:"R"},legacy={...cpt(),id:"L"};
    p.cpts=[automatic,reviewed,legacy];p.groundwater={mode:"assumed-depth",depth:0};p.cptRules=[{match:".*",unit:"B"}];
    const before=structuredClone(p),derived=refreshAutomaticCptLayers(p);
    expect(derived.cpts![0].layers).toEqual(classifiedLayers(p,automatic).layers);
    expect(derived.cpts![0].layers!.every(l=>l.unit==="B")).toBe(true);
    expect(derived.cpts![1]).toBe(reviewed);expect(derived.cpts![2]).toBe(legacy);
    expect(p).toEqual(before);
    p.cptRules[0].unit="A";p.groundwater.depth=8;
    const model=buildGeologicalModel(p);
    expect(model.project.cpts![0].layers).toEqual(classifiedLayers(p,automatic).layers);
    expect(model.project.cpts![0].layers!.every(l=>l.unit==="A")).toBe(true);
    expect(model.project.cpts![1].layers).toBe(reviewed.layers);expect(model.project.cpts![2].layers).toBe(legacy.layers);
    expect(model.warnings.join(" ")).toContain("do not reclassify these layers");
  });

  it("marks newly classified CPT layers automatic",()=>{
    const p=project(),c=cpt();delete c.layers;
    classifyCpts(p,[c]);expect(c.layersSource).toBe("automatic");expect(c.layers!.length).toBeGreaterThan(0);
  });

  it("roundtrips policies and layer provenance through JSON and editor base without legacy-field interference",()=>{
    const p=project();p.groundwater={mode:"as-of",date:"2026-11-14",includeUndated:true};p.cpts=[cpt("reviewed")];
    delete p.cpts[0].layers![0].evidenceId;
    const back=importFiles([{name:"p.json",text:toProjectJson(p)}]).project;
    expect(back.groundwater).toEqual(p.groundwater);expect(back.cpts![0].layersSource).toBe("reviewed");
    const tables=tablesFromProject(back);tables.project.groundwaterDepth="99";
    const edited=projectFromTables(tables,back).project;
    expect(edited.groundwater).toEqual(p.groundwater);expect(edited.groundwaterDepth).toBe(99);
    expect(groundwaterAt(edited,0,0,10)).toBe(5);
    const bad=JSON.parse(toProjectJson(p));bad.cpts[0].layersSource="guessed";
    expect(()=>importFiles([{name:"p.json",text:JSON.stringify(bad)}])).toThrow(/layersSource/);
  });

  it("keeps unfinished groundwater text in the draft and rejects it only when building",()=>{
    const p=project();p.groundwater={mode:"assumed-depth",depth:2};
    const tables=tablesFromProject(p);
    expect(tables.groundwaterDraft).toEqual({mode:"assumed-depth",depth:"2",date:"",includeUndated:false});
    tables.groundwaterDraft!.depth="-";
    expect(()=>projectFromTables(tables,p)).toThrow(/depth must be finite/);
    expect(tables.groundwaterDraft!.depth).toBe("-");expect(p.groundwater).toEqual({mode:"assumed-depth",depth:2});
    tables.groundwaterDraft!.depth="3,5";
    expect(projectFromTables(tables,p).project.groundwater).toEqual({mode:"assumed-depth",depth:3.5});
    tables.groundwaterDraft={mode:"as-of",depth:"3,5",date:"2026-",includeUndated:false};
    expect(()=>projectFromTables(tables,p)).toThrow(/ISO date/);
    tables.groundwaterDraft.mode="observed";
    expect(projectFromTables(tables,p).project.groundwater).toEqual({mode:"observed"});
  });
});
