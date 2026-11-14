import {describe,it,expect} from "vitest";
import {DraftHole,captureDraftEvidence,draftTables} from "../src/docread/draft";
import {textLine} from "../src/docread/reconstruct";
import {EvidenceSource,acceptEvidenceField,changeEvidenceField,validateEvidence} from "../src/evidence";
import {projectFromTables,tablesFromProject} from "../src/tables";
import {importFiles,toProjectJson} from "../src/io";

const line=(text:string,page=2,x0=100,y0=100,x1=300,y1=120)=>({...textLine(text,x0,y0,x1,y1),page});
const sources=():EvidenceSource[]=>[
  {id:"report",name:"report.pdf",sha256:"a".repeat(64),size:12345,pages:[{page:2,width:1000,height:800}]},
  {id:"unused",name:"unused.pdf",pages:[{page:1,width:100,height:100}]}
];
function hole():DraftHole{
  return {use:true,doc:0,file:"report.pdf",pages:[2],kind:"table",ocr:true,ocrPages:[2],
    values:{id:"BH-1",x:"100",y:"200",lat:"",lon:"",ground:"10",final:"8",water:"1.5"},
    flags:{ground:"Compare the elevation datum"},src:{id:line("BH-1"),ground:line("10.00 m"),water:line("1.50 m")},
    layers:[
      {from:"0",to:"2",unit:"Clay",description:"CLAY",autoUnit:true,src:[line("2.00"),line("CLAY",2,350,100,450,120)],flag:"Check the base depth"},
      {from:"2",to:"8",unit:"Sand",description:"SAND",autoUnit:true,src:[line("8.00",2,100,200,300,220),line("SAND",2,350,200,450,220)]}
    ]};
}
function prepare(h=hole()){
  const docs=sources();
  captureDraftEvidence([h],docs,()=>({width:1000,height:800}));
  return {h,docs};
}

describe("persistent evidence from document review",()=>{
  it("captures original parsed values and raw source text without treating extraction as human acceptance",()=>{
    const {h,docs}=prepare();
    expect(h.evidence!.method).toBe("ocr");
    expect(h.evidence!.fields.z).toMatchObject({original:"10",current:"10",status:"unreviewed",events:[],note:"Compare the elevation datum"});
    expect(h.evidence!.fields.z.boxes).toEqual([{page:2,x0:0.1,y0:0.125,x1:0.3,y1:0.15,text:"10.00 m"}]);
    expect(h.evidence!.fields.lat.boxes).toEqual([]);
    expect(h.layers[0].evidence!.fields.unit.note).toContain("unit rules");
    expect(h.layers[0].evidence!.fields.to.note).toBe("Check the base depth");
    const tables=draftTables([h],["report.pdf","unused.pdf"],docs);
    expect(validateEvidence(tables.evidence)).toEqual(tables.evidence);
    expect(tables.evidence!.records.every(r=>Object.values(r.fields).every(f=>f.status==="unreviewed"))).toBe(true);
  });

  it("retains stable evidence through renaming, correction, normalization and acceptance",()=>{
    const {h,docs}=prepare(),first=h.layers[0].evidence!,id=first.id;
    changeEvidenceField(first,"to","2,50","Edited in document review");h.layers[0].to="2,50";
    acceptEvidenceField(first,"to");
    changeEvidenceField(h.evidence!,"id","BH-renamed","Edited in document review");h.values.id="BH-renamed";
    const tables=draftTables([h],["report.pdf"],docs),record=tables.evidence!.records.find(r=>r.id===id)!;
    expect(tables.evidenceRows!.logs![0]).toBe(id);
    expect(record.fields.to.original).toBe("2");
    expect(record.fields.to.current).toBe("2.5");
    expect(record.fields.to.events.map(e=>e.action)).toEqual(["corrected","accepted","corrected"]);
    expect(record.fields.to.events.at(-1)!.reason).toBe("Normalised for input tables");
    expect(record.fields.boreholeId.current).toBe("BH-renamed");
    expect(record.fields.to.boxes[0].text).toBe("2.00");
    expect(h.layers[0].evidence!.fields.to.current).toBe("2,50");
    expect(validateEvidence(tables.evidence)).toEqual(tables.evidence);
  });

  it("keeps the right source when layers are removed, inserted or reordered",()=>{
    const {h,docs}=prepare(),second=h.layers[1].evidence!.id,removed=h.layers[0].evidence!.id;
    h.layers.splice(0,1);
    h.layers.unshift({from:"0",to:"2",unit:"Fill",description:"Added by the engineer",autoUnit:false,src:[]});
    const tables=draftTables([h],["report.pdf"],docs);
    expect(tables.evidenceRows!.logs).toEqual([null,second]);
    expect(tables.evidence!.records.some(r=>r.id===removed)).toBe(false);
    expect(tables.evidence!.records.find(r=>r.id===second)!.fields.description.original).toBe("SAND");
    expect(tables.evidence!.records.find(r=>r.id===second)!.fields.description.boxes.some(b=>b.text==="SAND")).toBe(true);
  });

  it("does not reset corrections when a review is redrawn and omits unused documents and holes",()=>{
    const {h,docs}=prepare(),id=h.evidence!.id;
    changeEvidenceField(h.evidence!,"z","11","Survey correction");h.values.ground="11";
    const unused={...hole(),use:false,doc:1,file:"unused.pdf",pages:[1]};
    captureDraftEvidence([h,unused],docs,()=>({width:1000,height:800}));
    expect(h.evidence!.id).toBe(id);
    expect(h.evidence!.fields.z.original).toBe("10");
    expect(h.evidence!.fields.z.current).toBe("11");
    const tables=draftTables([h,unused],["report.pdf","unused.pdf"],docs);
    expect(tables.evidence!.sources.map(s=>s.name)).toEqual(["report.pdf"]);
    expect(tables.evidence!.records.some(r=>r.sourceId==="unused")).toBe(false);
    tables.evidence!.records[0].fields.z.current="99";
    expect(h.evidence!.fields.z.current).toBe("11");
  });

  it("does not invent page boxes for missing or out-of-bounds source lines",()=>{
    const h=hole();h.src.ground=line("outside",2,-50,-10,-20,-1);h.src.id=line("point",2,20,20,20,40);
    captureDraftEvidence([h],sources(),()=>({width:1000,height:800}));
    expect(h.evidence!.fields.z.boxes).toEqual([]);
    expect(h.evidence!.fields.id.boxes).toEqual([]);
    expect(h.waterEvidence!.fields.date).toMatchObject({original:"",current:"",boxes:[],status:"unreviewed"});
  });

  it("preserves reviewed source links through the real table importer and project JSON",()=>{
    const {h,docs}=prepare();
    changeEvidenceField(h.layers[1].evidence!,"description","SAND, dense","Edited in document review");
    h.layers[1].description="SAND, dense";
    const tables=draftTables([h],["report.pdf"],docs),project=projectFromTables(tables).project;
    expect(project.boreholes[0].evidenceId).toBe(h.evidence!.id);
    expect(project.boreholes[0].intervals.map(i=>i.evidenceId)).toEqual(h.layers.map(l=>l.evidence!.id));
    expect(project.boreholes[0].water![0].evidenceId).toBe(h.waterEvidence!.id);
    const restored=importFiles([{name:"review.json",text:toProjectJson(project)}]).project;
    expect(restored.evidence).toEqual(project.evidence);
    expect(tablesFromProject(restored).evidenceRows).toMatchObject(tables.evidenceRows!);
  });
});
