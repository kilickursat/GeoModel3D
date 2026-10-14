// LandXML alignments: LandXML 1.2, and J-LandXML, the Japanese standard for exchanging 3-D design data that builds on
// it. Each alignment's horizontal geometry (lines, circular arcs and spirals) becomes points of its centreline with
// their chainage, the station along it, and its design profile (points of vertical intersection with their vertical
// curves) becomes design levels. LandXML lists positions as northing, easting.
import {parseXml,withoutPrefixes,XmlNode,childNodes,descendants} from "./xml";
import {Alignment,AlignmentPoint,DesignLevel} from "./schema";
import {XY} from "./tin";

export const isLandXml=(text:string)=>/<(?:[\w.-]+:)?LandXML[\s>]/.test(text.slice(0,4000));

// Metres per unit of length, by the names LandXML uses.
const LINEAR:Record<string,number>={meter:1,metre:1,millimeter:0.001,centimeter:0.01,decimeter:0.1,kilometer:1000,foot:0.3048,ussurveyfoot:1200/3937,inch:0.0254,mile:1609.344};
// Points of arcs and spirals are placed so that the chord between two lies within 2 cm of the curve.
const SAGITTA=0.02;

export interface LandXmlFile { alignments:Alignment[]; notes:string[]; crsCode?:string }

// The coordinate system a file names: an EPSG code, or, in J-LandXML, a zone of the Japanese plane rectangular system
// with its datum ("9(X,Y)" on JGD2011 is EPSG:6677).
function crsCode(doc:XmlNode){
  const cs=descendants(doc,"CoordinateSystem")[0];
  if(!cs)return undefined;
  const epsg=(cs.attrs.epsgCode??"").trim();
  if(/^\d{4,5}$/.test(epsg))return `EPSG:${epsg}`;
  const roman=["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV","XVI","XVII","XVIII","XIX"];
  const z=(cs.attrs.horizontalCoordinateSystemName??"").trim().match(/^(\d{1,2}|[IVX]+)\s*(?:系|\(|$)/i)?.[1];
  const zone=z?/^\d+$/.test(z)?Number(z):roman.indexOf(z.toUpperCase())+1:0;
  const datum=(cs.attrs.horizontalDatum??cs.attrs.datum??"").toUpperCase().replace(/\s/g,"");
  if(zone<1||zone>19)return undefined;
  if(datum.includes("JGD2011"))return `EPSG:${6668+zone}`;
  if(datum.includes("JGD2000"))return `EPSG:${2442+zone}`;
  if(datum.includes("TOKYO"))return `EPSG:${30160+zone}`;
  return undefined;
}

export function readLandXml(text:string,file:string):LandXmlFile{
  const doc=withoutPrefixes(parseXml(text)),notes:string[]=[];
  const units=descendants(doc,"Units")[0],unit=units?.children[0]?.attrs.linearUnit;
  const scale=unit?LINEAR[unit.toLowerCase()]:1;
  if(scale===undefined)throw new Error(`${file}: unknown unit of length “${unit}”`);
  if(scale!==1)notes.push(`${file}: lengths in ${unit} converted to metres`);
  // Named points, which elements may refer to instead of giving their coordinates.
  const named=new Map<string,string>();
  for(const p of descendants(doc,"CgPoint"))if(p.attrs.name)named.set(p.attrs.name,p.text.trim());
  const point=(n:XmlNode|undefined):XY|null=>{
    if(!n)return null;
    const v=(n.text.trim()||named.get(n.attrs.pntRef??"")||"").split(/[\s,]+/).map(Number);
    return v.length>=2&&Number.isFinite(v[0])&&Number.isFinite(v[1])?{x:v[1]*scale,y:v[0]*scale}:null;
  };
  const length=(n:XmlNode,key="length")=>{const v=Number(n.attrs[key]);return Number.isFinite(v)?v*scale:NaN};
  const alignments:Alignment[]=[];
  descendants(doc,"Alignment").forEach((al,i)=>{
    const name=al.attrs.name?.trim()||`Alignment ${i+1}`;
    const geometry=childNodes(al,"CoordGeom")[0];
    if(!geometry){notes.push(`${file}: ${name} has no horizontal geometry; left out`);return}
    const start=length(al,"staStart");
    const points:AlignmentPoint[]=[];
    let chainage=Number.isFinite(start)?start:0,heading=NaN,spirals=0,arcs=0,lines=0,backwards=false;
    const odd=new Set<string>(),drift:number[]=[];
    // Points are added with their chainage; an element's own staStart, where given, sets it.
    const add=(p:XY,c:number)=>{
      const last=points[points.length-1];
      if(last&&Math.hypot(p.x-last.x,p.y-last.y)<1e-3)return;
      points.push({x:p.x,y:p.y,chainage:c});
    };
    for(const e of geometry.children){
      // An element's own station, where it moves on from the one reached; a station going back is a station equation.
      const s=length(e,"staStart");
      if(Number.isFinite(s)){if(s>chainage+1e-3)chainage=s;else if(s<chainage-1e-3)backwards=true}
      const a=point(childNodes(e,"Start")[0]),b=point(childNodes(e,"End")[0]);
      if(e.tag==="Line"){
        if(!a||!b)continue;
        const l=Number.isFinite(length(e))?length(e):Math.hypot(b.x-a.x,b.y-a.y);
        add(a,chainage);add(b,chainage+l);
        heading=Math.atan2(b.y-a.y,b.x-a.x);
        chainage+=l;lines++;
      }else if(e.tag==="Curve"){
        const c=point(childNodes(e,"Center")[0]);
        if(!a||!b||!c){odd.add("curves without a start, centre and end");continue}
        const r=Math.hypot(a.x-c.x,a.y-c.y),ccw=(e.attrs.rot??"ccw").toLowerCase()==="ccw";
        const a0=Math.atan2(a.y-c.y,a.x-c.x),a1=Math.atan2(b.y-c.y,b.x-c.x);
        let sweep=ccw?a1-a0:a0-a1;
        while(sweep<=1e-12)sweep+=2*Math.PI;
        while(sweep>2*Math.PI)sweep-=2*Math.PI;
        const l=Number.isFinite(length(e))?length(e):r*sweep,dir=ccw?1:-1;
        const n=Math.min(2000,Math.max(1,Math.ceil(sweep/(2*Math.acos(Math.max(-1,1-SAGITTA/r))))));
        for(let k=0;k<=n;k++){const t=a0+dir*sweep*k/n;add(k===n?b:{x:c.x+r*Math.cos(t),y:c.y+r*Math.sin(t)},chainage+l*k/n)}
        heading=a1+dir*Math.PI/2;
        chainage+=l;arcs++;
      }else if(e.tag==="Spiral"){
        const pi=point(childNodes(e,"PI")[0]),L=length(e);
        if(!a||!(L>0)){odd.add("spirals without a start or a length");continue}
        // Curvature changes linearly along a clothoid, from 1/radiusStart to 1/radiusEnd (INF for a straight).
        const curvature=(v:string|undefined)=>{const r=Number(v)*scale;return !v||/inf/i.test(v)||!Number.isFinite(r)||r===0?0:1/r};
        const k0=curvature(e.attrs.radiusStart),k1=curvature(e.attrs.radiusEnd),turn=(e.attrs.rot??"ccw").toLowerCase()==="ccw"?1:-1;
        const type=(e.attrs.spiType??"clothoid").toLowerCase();
        if(type!=="clothoid")odd.add(`${e.attrs.spiType} spirals drawn as clothoids`);
        // The tangent at the start points to the spiral's PI, or else follows the element before.
        const h0=pi?Math.atan2(pi.y-a.y,pi.x-a.x):heading;
        if(!Number.isFinite(h0)){odd.add("spirals without a PI or a tangent before them");continue}
        const theta=(s:number)=>h0+turn*(k0*s+(k1-k0)*s*s/(2*L));
        // Positions by Simpson's rule on fine steps, kept at the spacing the sagitta allows.
        const steps=Math.max(200,Math.ceil(L/0.25)),kmax=Math.max(Math.abs(k0),Math.abs(k1),1e-9);
        const every=Math.max(1,Math.floor(Math.sqrt(8*SAGITTA/kmax)/(L/steps)));
        const path:Array<XY&{s:number}>=[{x:a.x,y:a.y,s:0}];
        let x=a.x,y=a.y;
        for(let k=0;k<steps;k++){
          const s0=L*k/steps,s1=L*(k+1)/steps,sm=(s0+s1)/2,h=(s1-s0)/6;
          x+=h*(Math.cos(theta(s0))+4*Math.cos(theta(sm))+Math.cos(theta(s1)));
          y+=h*(Math.sin(theta(s0))+4*Math.sin(theta(sm))+Math.sin(theta(s1)));
          if((k+1)%every===0||k+1===steps)path.push({x,y,s:s1});
        }
        // The end the file gives is kept: any difference is spread along the spiral.
        const ex=b?b.x-x:0,ey=b?b.y-y:0;
        if(b)drift.push(Math.hypot(ex,ey));
        for(const p of path)add({x:p.x+ex*p.s/L,y:p.y+ey*p.s/L},chainage+p.s);
        heading=theta(L);
        chainage+=L;spirals++;
      }else if(e.tag==="IrregularLine"){
        const list=childNodes(e,"PntList2D")[0]??childNodes(e,"PntList3D")[0],dim=list?.tag==="PntList3D"?3:2;
        const v=(list?.text??"").trim().split(/[\s,]+/).map(Number),pts:XY[]=[];
        for(let k=0;k+1<v.length;k+=dim)pts.push({x:v[k+1]*scale,y:v[k]*scale});
        pts.forEach((p,k)=>{if(k)chainage+=Math.hypot(p.x-pts[k-1].x,p.y-pts[k-1].y);add(p,chainage)});
        if(pts.length>1){heading=Math.atan2(pts[pts.length-1].y-pts[pts.length-2].y,pts[pts.length-1].x-pts[pts.length-2].x);lines++}
      }
    }
    if(points.length<2){notes.push(`${file}: ${name} has no geometry that can be drawn; left out`);return}
    const line:Alignment={name,points,source:file};
    const design=profileOf(al,scale,name,notes);
    if(design.length)line.design=design;
    const parts=[lines&&`${lines} straight${lines>1?"s":""}`,arcs&&`${arcs} arc${arcs>1?"s":""}`,spirals&&`${spirals} spiral${spirals>1?"s":""}`].filter(Boolean).join(", ");
    notes.push(`${file}: ${name}, ${parts}`);
    if(odd.size)notes.push(`${file}: ${name}: ${[...odd].join("; ")}`);
    const worst=Math.max(0,...drift);
    if(worst>0.05)notes.push(`${file}: ${name}: a spiral computed from its start ends ${worst.toFixed(2)} m from the end the file gives; it is adjusted to that end`);
    if(childNodes(al,"StaEquation").length||backwards)notes.push(`${file}: ${name}: station equations are not applied; chainage runs on along the line`);
    alignments.push(line);
  });
  if(!alignments.length)throw new Error(`${file}: no alignment with horizontal geometry`);
  return {alignments,notes,crsCode:crsCode(doc)};
}

// The design profile: elevations at the points of vertical intersection, joined by straight grades and by the
// parabolic vertical curves centred on them. Of several profiles, the first that does not name the existing ground.
function profileOf(al:XmlNode,scale:number,name:string,notes:string[]):DesignLevel[]{
  const all=descendants(al,"ProfAlign");
  const chosen=all.find(p=>!/\b(eg|og|existing|ground)\b|現況|地盤/i.test(p.attrs.name??""))??all[0];
  if(!chosen)return [];
  const pvi:Array<{s:number;z:number;L:number}>=[];
  let circular=false,unsymmetric=false;
  for(const e of chosen.children){
    const v=e.text.trim().split(/[\s,]+/).map(Number);
    if(v.length<2||!v.every(Number.isFinite))continue;
    let L=0;
    if(e.tag==="ParaCurve"||e.tag==="CircCurve")L=Number(e.attrs.length)*scale||0;
    else if(e.tag==="UnsymParaCurve")L=((Number(e.attrs.lengthIn)||0)+(Number(e.attrs.lengthOut)||0))*scale;
    else if(e.tag!=="PVI")continue;
    if(e.tag==="CircCurve")circular=true;
    if(e.tag==="UnsymParaCurve")unsymmetric=true;
    pvi.push({s:v[0]*scale,z:v[1]*scale,L});
  }
  if(pvi.length<2)return [];
  // The tangent grades, and on each vertical curve the parabola that joins the grades either side.
  const grade=(i:number)=>(pvi[i+1].z-pvi[i].z)/(pvi[i+1].s-pvi[i].s);
  const at=(c:number)=>{
    for(let i=1;i<pvi.length-1;i++){
      const p=pvi[i],h=p.L/2;
      if(h>0&&c>=p.s-h&&c<=p.s+h){const g0=grade(i-1),g1=grade(i),x=c-(p.s-h);return p.z-g0*h+g0*x+(g1-g0)*x*x/(2*p.L)}
    }
    let i=0;
    while(i<pvi.length-2&&c>pvi[i+1].s)i++;
    return pvi[i].z+grade(i)*(c-pvi[i].s);
  };
  const stations=new Set(pvi.map(p=>p.s));
  for(const p of pvi.slice(1,-1))if(p.L>0){const n=Math.max(4,Math.ceil(p.L/5));for(let k=0;k<=n;k++)stations.add(p.s-p.L/2+p.L*k/n)}
  const design=[...stations].sort((a,b)=>a-b).filter(c=>c>=pvi[0].s&&c<=pvi[pvi.length-1].s).map(c=>({chainage:c,top:at(c)}));
  const label=chosen.attrs.name?` ${chosen.attrs.name}`:"";
  notes.push(`${name}: profile${label} read as the design level, from ${pvi.length} points of vertical intersection`);
  if(circular)notes.push(`${name}: circular vertical curves drawn as parabolas of the same length`);
  if(unsymmetric)notes.push(`${name}: unsymmetrical vertical curves drawn as symmetrical ones of the same length`);
  return design;
}
