import {describe,expect,it} from "vitest";
import type {CollarScheduleRow} from "../src/docread/collarSchedule";
import {draftHoles,captureDraftEvidence,checkDraft,draftTables} from "../src/docread/draft";
import {textLine,type ReadLog} from "../src/docread/reconstruct";
import {decideSchedule,drilledLengthRow,hasPendingSchedule,useDrilledLength} from "../src/docread/reviewSchedule";
import {validateEvidence} from "../src/evidence";
import {projectFromTables} from "../src/tables";
import {importFiles,toProjectJson} from "../src/io";

const line=(text:string,page:number,y=20)=>({...textLine(text,10,y,100,y+10),page});
const field=(value:number,label:string)=>({value,line:line(String(value),2),heading:line(label,2,5)});
const size=()=>({width:200,height:200});
const docs=[{id:"report",name:"report.pdf",pages:[{page:2,...size()},{page:3,...size()}]}];
const log:ReadLog={id:"BH-4",pages:[3],kind:"table",flagged:[],x:301,y:402,ground:50,
  src:{id:line("Borehole BH-4",3),x:line("301",3),y:line("402",3)},layers:[{from:0,to:8,description:"Clay",src:[line("Clay",3)]}]};
const projected:CollarScheduleRow={id:"BH-4",page:2,idLine:line("BH-4",2),fields:{x:field(300000,"Easting (m)"),y:field(6800000,"Northing (m)")},
  coordinateKind:"projected",crsCode:"EPSG:28355",notes:["GDA94 / MGA zone 55"],context:[line("GDA94 / MGA zone 55",2)]};
const geographic:CollarScheduleRow={id:"BH-4",page:2,idLine:line("BH-4",2),fields:{lat:field(-28.5,"Latitude"),lon:field(145,"Longitude")},
  coordinateKind:"geographic",crsCode:"EPSG:28355",projectedFromGeographic:{x:303000,y:6790000},notes:["Use the surveyed geographic position."]};
function draft(rows=[projected,geographic]){
  const [h]=draftHoles(0,"report.pdf",[log],new Set(),new Map(),[{status:"ambiguous",candidates:rows,notes:[]}]);
  captureDraftEvidence([h],docs,size);
  return h;
}

function otherLog(doc:number,values:Partial<ReadLog>={}){
  const source=doc?"another.pdf":"report.pdf";
  return draftHoles(doc,source,[{...log,id:"BH-5",...values}])[0];
}

function otherSchedule(doc:number,template:CollarScheduleRow){
  const id="BH-5",row={...template,id,idLine:line(id,2),fields:{...template.fields,
    x:{...template.fields.x!,value:300050},y:{...template.fields.y!,value:6800000}}};
  const [h]=draftHoles(doc,doc?"another.pdf":"report.pdf",[{...log,id}],new Set(),new Map(),[{status:"conflict",notes:[],candidates:[row]}]);
  captureDraftEvidence([h],[...docs,{...docs[0],id:"other",name:"another.pdf"}],size);
  decideSchedule(h,0,size);
  return h;
}

describe("spatial references in reviewed reports",()=>{
  const files=["report.pdf","another.pdf"];
  function useRow(row=projected){
    const h=draft([row]);
    decideSchedule(h,0,size);
    return h;
  }
  it.each([0,1])("blocks a verified grid combined with unreferenced X/Y from document %s",doc=>{
    const known=useRow(),unknown=otherLog(doc),holes=[known,unknown];
    expect(checkDraft(holes)).toContainEqual(expect.objectContaining({hole:1,field:"x",level:"error",text:expect.stringContaining("EPSG:28355")}));
    expect(()=>draftTables(holes,files)).toThrow("EPSG:28355");
    unknown.use=false;
    expect(draftTables(holes,files).project.crs).toBe("EPSG:28355");
  });
  it("combines verified identical grids and rejects a different zone at both entry points",()=>{
    const known=useRow(),compatible=otherSchedule(1,projected);
    const built=projectFromTables(draftTables([known,compatible],files)).project;
    expect(built.boreholes.map(h=>h.x)).toEqual([300000,300050]);
    expect(built.crsCode).toBe("EPSG:28355");
    const other=otherSchedule(1,{...projected,crsCode:"EPSG:28354"});
    expect(checkDraft([known,other]).some(c=>c.level==="error"&&c.text.includes("EPSG:28354"))).toBe(true);
    expect(()=>draftTables([known,other],files)).toThrow("EPSG:28354");
  });
  it("converts geographic-only positions into the accepted grid, including a partially transcribed X/Y pair",()=>{
    const known=useRow(),geo=otherLog(1,{x:undefined,y:6789000,lat:-28.5,lon:145});
    const tables=draftTables([known,geo],files);
    expect(tables.project.crs).toBe("EPSG:28355");
    const built=projectFromTables(tables).project;
    expect(built.crsCode).toBe("EPSG:28355");
    expect(built.boreholes[1]).toMatchObject({id:"BH-5",lat:-28.5,lon:145});
    expect(built.boreholes[1].y).not.toBe(6789000);
  });
  it("keeps rows of one unnamed local grid together and blocks unrelated coordinate sources",()=>{
    const local={...projected,crsCode:undefined,context:[],notes:[]};
    const known=useRow(local),sameTable=otherSchedule(0,local);
    expect(projectFromTables(draftTables([known,sameTable],files)).project.boreholes).toHaveLength(2);
    const otherSheet=otherSchedule(0,{...local,fields:{...local.fields,x:{...local.fields.x!,heading:line("Easting (m)",2,140)}}});
    for(const other of [otherSheet,otherSchedule(1,local),otherLog(0)]){
      expect(checkDraft([known,other]).some(c=>c.level==="error"&&c.field==="x")).toBe(true);
      expect(()=>draftTables([known,other],files)).toThrow(/common grid/);
    }
  });
  it("compares printed reference systems even when log coordinates already match their own schedules",()=>{
    const kept=(id:string,crsCode:string)=>{
      const row={...projected,id,idLine:line(id,2),crsCode};
      const [h]=draftHoles(0,"report.pdf",[{...log,id,x:300000,y:6800000}],new Set(),new Map(),
        [{status:"confirmed",candidates:[row],notes:[]}]);
      captureDraftEvidence([h],docs,size);
      decideSchedule(h,"keep",size);
      return h;
    };
    const holes=[kept("BH-4","EPSG:28355"),kept("BH-5","EPSG:28354")];
    expect(()=>draftTables(holes,files)).toThrow(/EPSG:28355.*EPSG:28354/);
    expect(checkDraft(holes).some(c=>c.level==="error"&&c.field==="x")).toBe(true);
  });
  it("preserves the printed native datum when a log gives the same angles",()=>{
    const [h]=draftHoles(0,"report.pdf",[{...log,x:undefined,y:undefined,lat:-28.5,lon:145}],new Set(),new Map(),
      [{status:"confirmed",candidates:[geographic],notes:[]}]);
    captureDraftEvidence([h],docs,size);
    decideSchedule(h,"keep",size);
    expect(()=>draftTables([h],files)).toThrow(/printed angles/);
    decideSchedule(h,0,size);
    expect(projectFromTables(draftTables([h],files)).project.crsCode).toBe("EPSG:28355");
  });
  it("permits an unknown local grid and geographic positions to be reconciled in the input tables",()=>{
    const unknown=useRow({...projected,crsCode:undefined,context:[],notes:[]}),geo=otherLog(1,{x:undefined,y:undefined,lat:-28.5,lon:145});
    const tables=draftTables([unknown,geo],files);
    expect(tables.project.crs).toBe("");
    expect(()=>projectFromTables(tables)).toThrow(/coordinate system/);
    tables.project.crs="EPSG:28355";
    expect(projectFromTables(tables).project.crsCode).toBe("EPSG:28355");
  });
});

describe("reviewing a surveyed collar",()=>{
  it("keeps conflicting rows pending until the reviewer chooses and retains both the logged value and schedule source",()=>{
    const h=draft();
    expect(h.values.x).toBe("301");
    expect(hasPendingSchedule(h)).toBe(true);
    expect(checkDraft([h]).some(c=>c.level==="error"&&c.text.includes("collar schedule"))).toBe(true);
    decideSchedule(h,0,size);
    expect(h.values).toMatchObject({id:"BH-4",x:"300000",y:"6800000",ground:"50"});
    expect(hasPendingSchedule(h)).toBe(false);
    const tables=draftTables([h],["report.pdf"],docs);
    expect(tables.project.crs).toBe("EPSG:28355");
    expect(tables.project.description).toContain("2–3");
    const project=projectFromTables(tables).project;
    const restored=importFiles([{name:"report.json",text:toProjectJson(project)}]).project;
    expect(restored.crsCode).toBe("EPSG:28355");
    expect(restored.boreholes[0]).toMatchObject({id:"BH-4",x:300000,y:6800000,z:50});
    const record=restored.evidence!.records.find(r=>r.id===restored.boreholes[0].evidenceId)!;
    expect(record.fields.x).toMatchObject({original:"301",current:"300000",status:"accepted"});
    expect(record.fields.x.events.map(e=>e.action)).toEqual(["corrected","accepted"]);
    expect(record.fields.x.boxes.map(b=>[b.page,b.text])).toEqual([[2,"300000"],[2,"Easting (m)"],[2,"BH-4"],[2,"GDA94 / MGA zone 55"],[3,"301"]]);
    expect(record.fields["Collar schedule review"].current).toContain("projected");
    expect(validateEvidence(restored.evidence!)).toEqual(restored.evidence);
  });

  it("allows a reviewer to keep the current log and invalidates a disposition after edits",()=>{
    const h=draft();
    decideSchedule(h,"keep",size);
    expect(h.values.x).toBe("301");
    expect(h.evidence!.fields.x.status).toBe("unreviewed");
    expect(h.evidence!.fields["Collar schedule review"].boxes.map(b=>b.text)).toEqual(expect.arrayContaining(["300000","-28.5"]));
    h.values.x="302";
    expect(hasPendingSchedule(h)).toBe(true);
    h.values.id="BH-40";
    expect(()=>decideSchedule(h,0,size)).toThrow("ID differs");
    expect(h.values.x).toBe("302");
    decideSchedule(h,"keep",size);
    expect(hasPendingSchedule(h)).toBe(false);
    expect(draftTables([h],["report.pdf"],docs).project.crs).toBe("");
  });

  it("uses one coordinate representation and records a conversion without mislabelling native angles as WGS84",()=>{
    const h=draft();
    h.values.lat="-29";h.values.lon="146";
    decideSchedule(h,1,size);
    expect(h.values).toMatchObject({x:"303000",y:"6790000",lat:"",lon:""});
    expect(h.evidence!.fields.x.events[0].reason).toContain("Projected the printed latitude and longitude into EPSG:28355");
    expect(h.evidence!.fields.x.boxes.map(b=>b.text)).toEqual(expect.arrayContaining(["-28.5","145"]));
    expect(h.evidence!.fields["Collar schedule review"].current).toContain("lat -28.5");
    const restored=projectFromTables(draftTables([h],["report.pdf"],docs)).project;
    expect(restored.boreholes[0].x).toBe(303000);
    expect(restored.boreholes[0].lat).toBeUndefined();
    expect(restored.crsCode).toBe("EPSG:28355");
    decideSchedule(h,"keep",size);
    expect(draftTables([h],["report.pdf"],docs).project.crs).toBe("EPSG:28355");
  });

  it("preserves every field when a selected page has no dimensions and excludes pending holes from the decision gate",()=>{
    const h=draft();
    expect(()=>decideSchedule(h,0,()=>undefined)).toThrow("source box");
    expect(h.values.x).toBe("301");
    expect(h.evidence!.fields.x.events).toEqual([]);
    expect(hasPendingSchedule(h)).toBe(true);
    h.use=false;
    expect(checkDraft([h]).filter(c=>c.level==="error")).toEqual([]);
  });

  it("keeps the printed depths and description of a range-labelled graphic in their own evidence boxes",()=>{
    const graphic:ReadLog={...log,rangeLabels:true,layers:[{from:0,to:8,description:"Soft clay",src:[line("0–8 m",3),line("Soft clay",3,60)]}]};
    const [h]=draftHoles(0,"report.pdf",[graphic]);
    captureDraftEvidence([h],docs,size);
    const f=h.layers[0].evidence!.fields;
    expect(f.from.boxes.map(b=>b.text)).toEqual(["0–8 m"]);
    expect(f.from.note).toBeUndefined();
    expect(f.to.boxes).toEqual(f.from.boxes);
    expect(f.description.boxes.map(b=>b.text)).toEqual(["Soft clay"]);
  });

  it("exports the source page and reasons for leaving an incompatible pair unresolved",()=>{
    const [h]=draftHoles(0,"report.pdf",[{...log,x:undefined,y:undefined,ground:undefined,src:{id:line("BH-4",3)}}],new Set(),new Map(),[
      {status:"conflict",candidates:[projected,geographic],notes:["The two positions differ by 77.14 m. Ground elevation needs a vertical datum."]}]);
    captureDraftEvidence([h],docs,size);
    decideSchedule(h,"keep",size);
    const t=draftTables([h],["report.pdf"],docs);
    expect(t.rows.boreholes[0].slice(1,6)).toEqual(["","","","",""]);
    const saved=projectFromTables(t).project,restored=importFiles([{name:"saved.json",text:toProjectJson(saved)}]).project;
    const fields=restored.evidence!.records.find(r=>r.id===restored.boreholes[0].evidenceId)!.fields;
    expect(fields.x.current).toBe("");
    expect(fields["Collar schedule review"]).toMatchObject({status:"accepted",current:expect.stringContaining("Kept"),note:expect.stringContaining("77.14 m")});
    expect(fields["Collar schedule review"].boxes.map(b=>b.text)).toEqual(expect.arrayContaining(["GDA94 / MGA zone 55","300000","6800000","-28.5","145"]));
    expect(t.project.description).toContain("2–3");
  });

  it.each([true,false])("can retain a verified drilled length independently of the collar decision (depth first %s)",depthFirst=>{
    const length=field(135.5,"Drilled length (m)"),rows=[projected,geographic].map(r=>({...r,finalDepth:length}));
    const [h]=draftHoles(0,"report.pdf",[{...log,final:8}],new Set(),new Map(),[{status:"conflict",candidates:rows,notes:[]}]);
    captureDraftEvidence([h],docs,size);
    if(depthFirst){
      useDrilledLength(h,size);
      expect(hasPendingSchedule(h)).toBe(true);
    }
    decideSchedule(h,"keep",size);
    if(!depthFirst){
      expect(h.values.final).toBe("8");
      useDrilledLength(h,size);
    }
    expect(hasPendingSchedule(h)).toBe(false);
    expect(h.values).toMatchObject({x:"301",y:"402",final:"135.5"});
    const project=projectFromTables(draftTables([h],["report.pdf"],docs)).project;
    const restored=importFiles([{name:"saved.json",text:toProjectJson(project)}]).project;
    expect(restored.boreholes[0].depth).toBe(135.5);
    expect(restored.boreholes[0].intervals.at(-1)?.to).toBe(8);
    const f=restored.evidence!.records.find(r=>r.id===h.evidence?.id)!.fields.depth;
    expect(f).toMatchObject({original:"8",current:"135.5",status:"accepted"});
    expect(f.boxes.map(b=>[b.page,b.text])).toEqual([[2,"135.5"],[2,"Drilled length (m)"],[2,"BH-4"]]);
    h.values.id="BH-40";
    expect(checkDraft([h]).some(c=>c.level==="error"&&c.field==="final")).toBe(true);
  });

  it("leaves conflicting, unrelated and too-shallow drilled lengths for review",()=>{
    const a={...projected,finalDepth:field(5,"Drilled length")},b={...geographic,finalDepth:field(12,"Drilled length")};
    const [h]=draftHoles(0,"report.pdf",[log],new Set(),new Map(),[{status:"ambiguous",candidates:[a,b],notes:[]}]);
    captureDraftEvidence([h],docs,size);
    expect(drilledLengthRow(h)).toBeUndefined();
    decideSchedule(h,0,size);
    expect(()=>useDrilledLength(h,size)).toThrow("extends below");
    expect(h.values.final).toBe("");
    decideSchedule(h,1,size);
    h.values.id="Other site";
    expect(()=>useDrilledLength(h,size)).toThrow();
    expect(h.values.final).toBe("");
  });
});
