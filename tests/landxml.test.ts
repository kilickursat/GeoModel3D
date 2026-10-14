import {describe,it,expect} from "vitest";
import {readLandXml,isLandXml} from "../src/landxml";
import {importFiles} from "../src/io";
import {designAt,chainages} from "../src/alignment";
import {valleyProject,sakaeProject} from "../src/geology";

// A LandXML file around an alignment's geometry and profile; positions are northing, easting.
const landXml=(geometry:string,profile="",head='<Units><Metric linearUnit="meter"/></Units>',attrs='staStart="0"')=>
  `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">${head}<Alignments><Alignment name="CL" ${attrs}><CoordGeom>${geometry}</CoordGeom>${profile}</Alignment></Alignments></LandXML>`;
// The clothoid from the origin heading east, turning left, with A² = R·L: the Fresnel integrals by their series.
const clothoid=(s:number,A2:number)=>({x:s-s**5/(40*A2**2)+s**9/(3456*A2**4),y:s**3/(6*A2)-s**7/(336*A2**3)+s**11/(42240*A2**5)});

describe("LandXML alignments",()=>{
  it("follow a clothoid as the Fresnel integrals give it",()=>{
    const r=readLandXml(landXml('<Spiral length="50" radiusStart="INF" radiusEnd="200" rot="ccw" spiType="clothoid"><Start>0 0</Start><PI>0 30</PI></Spiral>'),"s.xml");
    const a=r.alignments[0];
    expect(isLandXml(landXml(""))).toBe(true);
    expect(a.points.length).toBeGreaterThan(5);
    for(const p of a.points){
      const e=clothoid(p.chainage!,200*50);
      expect(p.x).toBeCloseTo(e.x,4);
      expect(p.y).toBeCloseTo(e.y,4);
    }
    const end=a.points[a.points.length-1];
    expect(end.chainage).toBe(50);
    expect(end.x).toBeCloseTo(49.92193,4);
    expect(end.y).toBeCloseTo(2.08101,4);
  });

  it("join straights and arcs, with chainage along the arc and the stations given",()=>{
    const geometry=`<Line><Start>0 0</Start><End>0 100</End></Line>
      <Curve rot="ccw" radius="100" length="157.0796327"><Start>0 100</Start><Center>100 100</Center><End>100 200</End></Curve>
      <Line staStart="1257.0796327"><Start>100 200</Start><End>200 200</End></Line>`;
    const a=readLandXml(landXml(geometry,"",undefined,'staStart="1000"'),"c.xml").alignments[0],ch=chainages(a);
    expect(a.points[0]).toEqual({x:0,y:0,chainage:1000});
    const arc=a.points.filter(p=>p.chainage!>=1100&&p.chainage!<=1257.08);
    for(const p of arc)expect(Math.hypot(p.x-100,p.y-100)).toBeCloseTo(100,9);
    for(let k=1;k<arc.length;k++)expect(arc[k].chainage!-arc[k-1].chainage!).toBeCloseTo(100*Math.abs(Math.atan2(arc[k].y-100,arc[k].x-100)-Math.atan2(arc[k-1].y-100,arc[k-1].x-100)),6);
    expect(a.points.some(p=>p.x===200&&p.y===100&&Math.abs(p.chainage!-1257.0796327)<1e-6)).toBe(true);
    expect(ch[ch.length-1]).toBeCloseTo(1357.0796327,6);
    for(let k=1;k<ch.length;k++)expect(ch[k]).toBeGreaterThan(ch[k-1]);
  });

  it("give the design profile with its parabolic vertical curves",()=>{
    const profile='<Profile><ProfAlign name="FG"><PVI>0 10</PVI><ParaCurve length="100">200 14</ParaCurve><PVI>400 10</PVI></ProfAlign><ProfSurf name="EG"/></Profile>';
    const r=readLandXml(landXml("<Line><Start>0 0</Start><End>0 400</End></Line>",profile),"p.xml"),d=r.alignments[0].design!;
    expect(designAt(d,100).top).toBeCloseTo(12,9);
    expect(designAt(d,150).top).toBeCloseTo(13,9);
    expect(designAt(d,175).top).toBeCloseTo(13.375,9);
    // The middle ordinate of a symmetrical vertical curve: the change of grade times its length over eight.
    expect(designAt(d,200).top).toBeCloseTo(14-0.04*100/8,9);
    expect(designAt(d,300).top).toBeCloseTo(12,9);
    expect(r.notes.join(" ")).toMatch(/profile FG read as the design level, from 3 points of vertical intersection/);
  });

  it("read US survey feet, named points, and the coordinate system the file names",()=>{
    const ft=readLandXml(landXml("<Line><Start>0 0</Start><End>0 1000</End></Line>","",'<Units><Imperial linearUnit="USSurveyFoot"/></Units>'),"f.xml");
    expect(ft.alignments[0].points[1].x).toBeCloseTo(1000*1200/3937,9);
    expect(ft.notes.join(" ")).toMatch(/USSurveyFoot converted to metres/);
    const refs=readLandXml(landXml('<Line><Start pntRef="A"/><End pntRef="B"/></Line>','','<CgPoints><CgPoint name="A">10 20</CgPoint><CgPoint name="B">30 60</CgPoint></CgPoints>'),"r.xml");
    expect(refs.alignments[0].points.map(p=>[p.x,p.y])).toEqual([[20,10],[60,30]]);
    const zone=(name:string,datum:string)=>readLandXml(landXml("<Line><Start>0 0</Start><End>0 10</End></Line>","",`<CoordinateSystem horizontalDatum="${datum}" verticalDatum="TP" horizontalCoordinateSystemName="${name}"/>`),"j.xml").crsCode;
    expect(zone("9(X,Y)","JGD2011")).toBe("EPSG:6677");
    expect(zone("IX","JGD2011")).toBe("EPSG:6677");
    expect(zone("9","JGD2000")).toBe("EPSG:2451");
    expect(readLandXml(landXml("<Line><Start>0 0</Start><End>0 10</End></Line>","",'<CoordinateSystem epsgCode="28992"/>'),"e.xml").crsCode).toBe("EPSG:28992");
  });

  it("import onto the project shown, in its coordinate system",()=>{
    const geometry=`<Line><Start>-68400 -29050</Start><End>-68950 -28890</End></Line>`;
    const head='<Units><Metric linearUnit="meter"/></Units><CoordinateSystem horizontalDatum="JGD2011" horizontalCoordinateSystemName="9(X,Y)"/>';
    const r=importFiles([{name:"route.xml",text:landXml(geometry,"",head)}],sakaeProject);
    expect(r.alignments).toEqual(["CL"]);
    expect(r.project.alignments![0].points[0]).toMatchObject({x:-29050,y:-68400});
    expect(r.warnings.join(" ")).toMatch(/CL, 1 straight/);
    const elsewhere=importFiles([{name:"route.xml",text:landXml(geometry,"",head)}],valleyProject);
    expect(elsewhere.warnings.join(" ")).toMatch(/read as the project's coordinates/);
    expect(()=>importFiles([{name:"empty.xml",text:landXml("")}],valleyProject)).toThrow(/geometry/);
  });
});
