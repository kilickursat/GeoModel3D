import {describe,it,expect} from "vitest";
import {reportHtml} from "../src/report";
import {buildGeologicalModel} from "../src/model";
import {computeSection} from "../src/section";
import type {GeoProject} from "../src/schema";
import type {EvidenceCollection,EvidenceField} from "../src/evidence";
import {acceptEvidenceField,changeEvidenceField} from "../src/evidence";
import {importFiles,toProjectJson} from "../src/io";

const options={paper:"A4" as const,date:"2026-11-14",version:"0.19.1",credits:[],notes:[],sectionBuffer:20,ve:1};
const field=(value:string):EvidenceField=>({original:value,current:value,boxes:[{page:3,x0:0.1,y0:0.1,x1:0.9,y1:0.2,text:`Read <${value}> & original`}],status:"unreviewed",events:[]});
function project():GeoProject{
  const evidence:EvidenceCollection={version:1,sources:[{id:"doc",name:"Report <script>.pdf",sha256:"b".repeat(64),pages:[{page:3,width:600,height:800}]}],
    records:[{id:"header",sourceId:"doc",method:"pdf-text",fields:{id:field("BH-1"),z:field("10")}},
      {id:"layer",sourceId:"doc",method:"ocr",fields:{from:field("0"),to:field("4"),unit:field("clay"),description:field("Clay")}},
      {id:"water",sourceId:"doc",method:"pdf-text",fields:{depth:field("2")}},
      {id:"deleted",sourceId:"doc",method:"manual",fields:{description:field("Deleted evidence must not be printed")}}]};
  acceptEvidenceField(evidence.records[0],"z");
  changeEvidenceField(evidence.records[1],"to","5","Checked the depth scale");
  evidence.records[1].fields.to.note="Decimal <point> uncertain";
  return {name:"Evidence site",units:[{id:"clay",name:"Clay",color:"#998877"}],boreholes:[{id:"BH-1",x:0,y:0,z:10,evidenceId:"header",
    intervals:[{from:0,to:5,unit:"clay",name:"Clay",evidenceId:"layer"}],water:[{depth:2,evidenceId:"water"}]}],evidence};
}
function report(p:GeoProject){const model=buildGeologicalModel(p);return reportHtml(model,computeSection(model,{azimuth:0,offset:0}),options)}

describe("evidence in printable reports",()=>{
  it("prints sources, current observation values, corrections and exact review states",()=>{
    const html=report(project());
    expect(html).toContain("<h2>Source evidence</h2>");
    expect(html).toContain("Report &lt;script&gt;.pdf");
    expect(html).toContain("SHA-256 "+"b".repeat(64));
    expect(html).toContain("page 3");
    expect(html).toContain("PDF text");expect(html).toContain("OCR");
    expect(html).toContain("<b>To:</b> 5");expect(html).toContain("<b>To:</b> 4");
    expect(html).toContain("Accepted:</b> Ground level");
    expect(html).toContain("Corrected, awaiting acceptance:</b> To");
    expect(html).toContain("Unreviewed:");
    expect(html).toContain("Decimal &lt;point&gt; uncertain");
    expect(html).toContain("Read &lt;4&gt; &amp; original");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Deleted evidence must not be printed");
  });

  it("uses current project values and marks acceptance stale if a linked value changed outside review",()=>{
    const p=project();p.boreholes[0].z=11;
    const html=report(p);
    expect(html).toContain("<b>Ground level:</b> 11");
    expect(html).toContain("Changed after review:</b> Ground level");
    expect(html).not.toContain("Accepted:</b> Ground level");
  });

  it("does not treat numeric formatting as a change to an accepted value",()=>{
    const p=project(),f=p.evidence!.records[0].fields.z;
    f.original="10,00";f.current="10,00";f.events[0].value="10,00";
    const html=report(p);
    expect(html).toContain("Accepted:</b> Ground level");
    expect(html).not.toContain("Changed after review:</b> Ground level");
  });

  it("keeps an accepted final depth when the importer omits a redundant explicit depth",()=>{
    const p=project(),b=p.boreholes[0],header=p.evidence!.records[0];
    b.depth=8;b.intervals[0].to=8;
    header.fields.depth=field("8");acceptEvidenceField(header,"depth");
    const imported=importFiles([{name:"accepted-depth.json",text:toProjectJson(p)}]).project;
    expect(imported.boreholes[0].depth).toBeUndefined();
    const html=report(imported);
    expect(html).toContain("<b>Depth:</b> 8");
    expect(html).toContain("Accepted:</b> Ground level, Depth");
    expect(html).not.toContain("Changed after review:</b> Depth");
  });

  it("shows the current parent borehole on interval and water evidence after a rename",()=>{
    const p=project();
    for(const record of [p.evidence!.records[1],p.evidence!.records[2]]){
      record.fields.boreholeId=field("BH-1");acceptEvidenceField(record,"boreholeId");
    }
    p.boreholes[0].id="Renamed BH";
    const html=report(p);
    // Header, interval and water each use the current observation rather than the stored evidence name.
    expect(html.match(/<b>Borehole:<\/b> Renamed BH/g)).toHaveLength(3);
    expect(html.match(/Changed after review:<\/b> Borehole/g)).toHaveLength(3);
    expect(html).not.toContain("Accepted:</b> Borehole");
  });

  it("does not embed saved source images and prints only used source documents",()=>{
    const p=project();p.evidence!.sources[0].pages[0].image="data:image/png;base64,SOURCE_IMAGE_MARKER";
    p.evidence!.sources.push({id:"unused",name:"Unrelated confidential report.pdf",pages:[]});
    const html=report(p);
    expect(html).not.toContain("SOURCE_IMAGE_MARKER");
    expect(html).not.toContain("Unrelated confidential report.pdf");
  });

  it("renders ordinary field names inherited from Object.prototype as text",()=>{
    const p=project();
    for(const key of ["toString","valueOf","hasOwnProperty"]){
      p.evidence!.records[0].fields[key]=field(`Value of ${key}`);
      acceptEvidenceField(p.evidence!.records[0],key);
    }
    const html=report(p);
    for(const key of ["toString","valueOf","hasOwnProperty"]){
      expect(html).toContain(`<b>${key}:</b> Value of ${key}`);
      expect(html).not.toContain(`Changed after review:</b> ${key}`);
    }
  });

  it("adds no evidence appendix to a project without linked source records",()=>{
    const p=project();delete p.evidence;
    for(const b of p.boreholes){delete b.evidenceId;for(const i of b.intervals)delete i.evidenceId;for(const w of b.water??[])delete w.evidenceId}
    expect(report(p)).not.toContain("<h2>Source evidence");
  });
});
