import {afterEach,describe,expect,it,vi} from "vitest";
import {acceptEvidenceField,changeEvidenceField,evidenceRecord,EvidenceCollection,EVIDENCE_MAX_PAGE_IMAGE_BYTES,newEvidenceId,validateEvidence} from "../src/evidence";

const PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYh8AAAAASUVORK5CYII=";
const START="2026-11-14T00:00:00.000Z";
function evidence():EvidenceCollection{
  return {version:1,sources:[{id:"source-1",name:"Reviewed log.pdf",sha256:"a".repeat(64),size:12345,
    pages:[{page:2,width:600,height:800,image:PNG},{page:3,width:600,height:800}]}],records:[{
    id:"hole-1",sourceId:"source-1",method:"ocr",fields:{
      ground:{original:"4.5",current:"4.5",status:"unreviewed",events:[],note:"Decimal point inferred from the page scale.",
        boxes:[{page:2,x0:0.1,y0:0.2,x1:0.3,y1:0.25,text:"450"}]},
      id:{original:"BH1",current:"BH1",status:"unreviewed",events:[],boxes:[]}
    }
  }]};
}
afterEach(()=>vi.useRealTimers());

describe("evidence editing",()=>{
  it("preserves source text, boxes and extraction notes through acceptance, corrections and reacceptance",()=>{
    vi.useFakeTimers();vi.setSystemTime(START);
    const doc=evidence(),r=doc.records[0],f=r.fields.ground,boxes=f.boxes;
    acceptEvidenceField(r,"ground");
    expect(f.status).toBe("accepted");
    expect(f.events).toEqual([{at:START,action:"accepted",value:"4.5"}]);
    changeEvidenceField(r,"ground","4.6","Checked the scale against the original page.");
    expect(f.status).toBe("corrected");
    expect(f.original).toBe("4.5");expect(f.current).toBe("4.6");
    expect(f.boxes).toBe(boxes);expect(f.boxes[0].text).toBe("450");
    expect(f.note).toContain("Decimal point");
    expect(f.events[1]).toEqual({at:START,action:"corrected",previous:"4.5",value:"4.6",reason:"Checked the scale against the original page."});
    acceptEvidenceField(r,"ground");
    expect(f.status).toBe("accepted");expect(f.events[2].value).toBe("4.6");
    expect(validateEvidence(doc)).toEqual(doc);
    changeEvidenceField(r,"ground","4.5");
    expect(f.status).toBe("corrected"); // Returning to the extraction does not restore an old acceptance.
    expect(validateEvidence(doc)).toEqual(doc);
  });

  it("does not create events for unchanged values and supports fields added by hand",()=>{
    const doc=evidence(),r=doc.records[0];acceptEvidenceField(r,"id");
    changeEvidenceField(r,"id","BH1");expect(r.fields.id.events).toHaveLength(1);
    expect(r.fields.id.status).toBe("accepted");
    changeEvidenceField(r,"final","20");
    expect(r.fields.final).toMatchObject({original:"",current:"20",boxes:[],status:"corrected"});
    expect(validateEvidence(doc)).toEqual(doc);
    expect(()=>acceptEvidenceField(r,"missing")).toThrow(/no evidence/);
  });

  it("keeps event order if the device clock moves backwards",()=>{
    vi.useFakeTimers();vi.setSystemTime(START);
    const doc=evidence(),r=doc.records[0];acceptEvidenceField(r,"id");
    vi.setSystemTime("2026-11-13T00:00:00.000Z");changeEvidenceField(r,"id","BH-01");
    expect(r.fields.id.events[1].at).toBe(START);
    expect(validateEvidence(doc)).toEqual(doc);
  });

  it("looks up stable records without tying them to edited borehole names",()=>{
    const doc=evidence();changeEvidenceField(doc.records[0],"id","Renamed borehole");
    expect(evidenceRecord(doc,"hole-1")).toBe(doc.records[0]);
    expect(evidenceRecord(doc,"Renamed borehole")).toBeUndefined();
    expect(evidenceRecord(undefined,"hole-1")).toBeUndefined();
    expect(evidenceRecord(doc,undefined)).toBeUndefined();
    const ids=new Set(Array.from({length:100},newEvidenceId));expect(ids.size).toBe(100);
  });
});

describe("evidence import validation",()=>{
  it("roundtrips optional fields, page previews and reviewed history as detached data",()=>{
    const input=evidence();changeEvidenceField(input.records[0],"id","BH-01");acceptEvidenceField(input.records[0],"id");
    const result=validateEvidence(JSON.parse(JSON.stringify(input)));
    expect(result).toEqual(input);
    result.sources[0].pages[0].image="changed";
    result.records[0].fields.id.events[0].value="changed";
    result.records[0].fields.ground.boxes[0].text="changed";
    expect(input.sources[0].pages[0].image).toBe(PNG);
    expect(input.records[0].fields.id.events[0].value).toBe("BH-01");
    expect(input.records[0].fields.ground.boxes[0].text).toBe("450");
  });

  it("accepts manual evidence without a snapshot and optional keys explicitly undefined",()=>{
    const input:EvidenceCollection={version:1,sources:[{id:"manual",name:"Site notes",pages:[],sha256:undefined,size:undefined}],
      records:[{id:"entry",sourceId:"manual",method:"manual",fields:{"Ground level (m)":{original:"10",current:"10",boxes:[],status:"unreviewed",events:[],note:undefined}}}]};
    const parsed=validateEvidence(input);
    expect(parsed.records[0].fields["Ground level (m)"].current).toBe("10");
    expect(parsed.sources[0].pages).toEqual([]);
    expect(validateEvidence({version:1,sources:[],records:[]})).toEqual({version:1,sources:[],records:[]});
  });

  it.each([
    ["version",(d:any)=>{d.version=2}],
    ["must not be missing",(d:any)=>{delete d.records[0].fields.ground.boxes[0]}],
    ["supported field",(d:any)=>{d.rawPdf="hidden bytes"}],
    ["duplicated",(d:any)=>{d.sources.push(structuredClone(d.sources[0]))}],
    ["duplicated",(d:any)=>{d.records.push(structuredClone(d.records[0]))}],
    ["does not name a source",(d:any)=>{d.records[0].sourceId="unknown"}],
    ["does not name a source page",(d:any)=>{d.records[0].fields.ground.boxes[0].page=99}],
    ["positive integer",(d:any)=>{d.sources[0].pages[0].page=0}],
    ["duplicated",(d:any)=>{d.sources[0].pages.push(structuredClone(d.sources[0].pages[0]))}],
    ["finite number",(d:any)=>{d.sources[0].pages[0].width=Infinity}],
    ["page dimensions",(d:any)=>{d.sources[0].pages[0].height=-1}],
    ["normalized",(d:any)=>{d.records[0].fields.ground.boxes[0].x0=-0.01}],
    ["normalized",(d:any)=>{d.records[0].fields.ground.boxes[0].y1=1.01}],
    ["normalized",(d:any)=>{d.records[0].fields.ground.boxes[0].x1=0.1}],
    ["finite number",(d:any)=>{d.records[0].fields.ground.boxes[0].y1=NaN}],
    ["PNG data URL",(d:any)=>{d.sources[0].pages[0].image="https://example.com/page.png"}],
    ["PNG data URL",(d:any)=>{d.sources[0].pages[0].image="data:image/svg+xml,<svg onload='alert(1)'/>"}],
    ["base64",(d:any)=>{d.sources[0].pages[0].image="data:image/png;base64,not base64"}],
    ["PNG image",(d:any)=>{d.sources[0].pages[0].image="data:image/png;base64,"+btoa("<script>fake PNG</script>")}],
    ["SHA-256",(d:any)=>{d.sources[0].sha256="xyz"}],
    ["byte count",(d:any)=>{d.sources[0].size=-1}],
    ["pdf-text",(d:any)=>{d.records[0].method="cloud-ai"}],
    ["history",(d:any)=>{d.records[0].fields.ground.current="8"}],
    ["history",(d:any)=>{d.records[0].fields.ground.status="accepted"}],
    ["string",(d:any)=>{d.records[0].fields.ground.note=42}]
  ])("rejects malformed %s",(message,edit)=>{
    const d=evidence();(edit as (d:any)=>void)(d);expect(()=>validateEvidence(d)).toThrow(message as string);
  });

  it("rejects image sizes before decoding and excessive raster dimensions before rendering",()=>{
    const d=evidence();d.sources[0].pages[0].image="data:image/png;base64,"+"A".repeat(4*Math.ceil(EVIDENCE_MAX_PAGE_IMAGE_BYTES/3)+4);
    expect(()=>validateEvidence(d)).toThrow(/page image limit/);
    const raw=atob(PNG.split(",")[1]),wide=raw.slice(0,16)+String.fromCharCode(0,0,32,0)+raw.slice(20);
    d.sources[0].pages[0].image="data:image/png;base64,"+btoa(wide);
    expect(()=>validateEvidence(d)).toThrow(/PNG dimensions/);
  });

  it("rejects inconsistent event values, actions, statuses and timestamps",()=>{
    const base=evidence();changeEvidenceField(base.records[0],"id","BH2");acceptEvidenceField(base.records[0],"id");
    const changes=[
      (d:EvidenceCollection)=>{d.records[0].fields.id.events[0].previous="wrong"},
      (d:EvidenceCollection)=>{d.records[0].fields.id.events[1].value="wrong"},
      (d:EvidenceCollection)=>{d.records[0].fields.id.events[1].at="yesterday"},
      (d:EvidenceCollection)=>{d.records[0].fields.id.events[1].at="2020-01-01T00:00:00.000Z"},
      (d:EvidenceCollection)=>{d.records[0].fields.id.current="wrong"},
      (d:EvidenceCollection)=>{d.records[0].fields.id.status="unreviewed"},
      (d:EvidenceCollection)=>{d.records[0].fields.id.status="corrected"}
    ];
    for(const change of changes){const d=structuredClone(base);change(d);expect(()=>validateEvidence(d)).toThrow(/Invalid evidence/)}
  });

  it("rejects prototype keys on import and edit",()=>{
    const d=evidence();
    d.records[0].fields=JSON.parse('{"__proto__":{}}');
    expect(()=>validateEvidence(d)).toThrow(/supported field/);
    expect(()=>changeEvidenceField(evidence().records[0],"__proto__","value")).toThrow(/field name/);
    expect(()=>acceptEvidenceField(evidence().records[0],"constructor")).toThrow(/field name/);
  });
});
