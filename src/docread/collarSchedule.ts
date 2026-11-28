import type {ReadLog,TextLine} from "./reconstruct";
import {crsRegistry,findCrs,toProjected} from "../crs";
import proj4 from "proj4";

export type CollarField="x"|"y"|"ground"|"lat"|"lon";
export interface CollarScheduleRow {
  id:string;
  page:number;
  idLine:TextLine;
  fields:Partial<Record<CollarField,{value:number;line:TextLine;heading:TextLine}>>;
  notes:string[];
  finalDepth?:{value:number;line:TextLine;heading:TextLine};
  context?:TextLine[];
  coordinateKind?:"projected"|"geographic";
  coordinateConflict?:boolean;
  crsCode?:string;
  projectedFromGeographic?:{x:number;y:number};
}
export interface CollarScheduleMatch {
  status:"missing"|"proposed"|"confirmed"|"conflict"|"ambiguous";
  candidates:CollarScheduleRow[];
  notes:string[];
}

type Label=CollarField|"id"|"finalDepth"|"orientation";
type QualifierKind="frame"|"verticalDatum"|"units";
interface Qualifier {kind:QualifierKind;heading:TextLine;cells:TextLine[]}
interface Column {label?:Label;heading:TextLine;unit?:TextLine;qualifier?:QualifierKind}
const dimensions:CollarField[]=["x","y","ground","lat","lon"];
const metre=/(?:\bmet(?:re|er)s?\b|\bm\b|\d(?:m|metres?|meters?)\b)/i;
const nonMetric=/\b(?:f(?:ee|oo)t|ft|yards?|yd|km|km2|cm|mm)\b/i;
const datum=/\b(?:EPSG\s*:?\s*\d{4,6}|UTM(?:\s+zone)?\s*\d{1,2}[NS]?|WGS\s*[- ]?\s*84|NAD\s*[- ]?\s*(?:27|83)|NAVD\s*[- ]?\s*88|GDA\s*(?:94|2020)|AHD|AOD|ODN|NZGD\s*2000|NZTM\s*2000|ITM|Irish Grid)\b/i;
const coordinateUnits=/\b(?:coordinates?|eastings? and northings?)\s+(?:are\s+)?(?:given\s+|expressed\s+)?in\s+(?:metres?|meters?|feet|ft)\b|\bcoordinates?\s*\((?:m|ft)\)/i;
const allUnits=/\ball\s+(?:measurements|dimensions|distances|values|units)\s+(?:are\s+)?in\s+(?:metres?|meters?|feet|ft)\b/i;
const wgs=/\bWGS\s*[- ]?\s*84\b/i;

function qualifier(text:string):QualifierKind|undefined{
  const t=text.trim().toLowerCase().replace(/co-ordinate/g,"coordinate").replace(/[_:]/g," ").trim();
  if(/\bunits?\s*(?:$|\(|\[|of measure(?:ment)?\b)|^u\.?o\.?m\.?$/.test(t))return "units";
  if(/^(?:vertical|height|elevation) (?:reference|datum|crs)|^datum\s*\((?:vertical|height|elevation)\)/.test(t))return "verticalDatum";
  const prefix=/^(?:(?:coord(?:inate)?\.?|horizontal|survey|map|spatial|geodetic|gps|utm|mga|grid) )+/;
  const core=t.replace(prefix,"");
  if(/^(?:crs|srs|srid|datum|epsg|grid|projection|zone|coordinate system|reference (?:system|frame)|hemisphere)\b/.test(t)||
     core!==t&&/^(?:crs|srs|srid|datum|epsg|grid|projection|zone|system|ref(?:erence)?|hemisphere)\b/.test(core))return "frame";
}

function label(text:string):Label|undefined{
  const t=text.trim().toLowerCase().replace(/[:.]$/,"");
  if(/^(?:(?:bore\s*hole|boring|drill\s*hole|well|hole|site|bh)(?:\s*(?:id|name|number|no\.?|ref(?:erence)?|designation|identifier|#))?|id|identifier)$/.test(t))return "id";
  if(/^(?:(?:total |final )?(?:drilled (?:length|depth)|borehole depth|hole depth)|(?:total|final|completed) (?:vertical )?depth)(?:$|\s*\((?:m|metres?|meters?|ft|feet)\)$|\s+(?:m|metres?|meters?|ft|feet)$)/.test(t))return "finalDepth";
  if(/^(?:(?:hole|borehole) )?(?:inclination|deviation|dip)(?:$|\s*\([^)]*\)$)/.test(t))return "orientation";
  if(/^(?:utm\s+)?easting(?:s)?\b|^e\s*\((?:m|ft)\)$/.test(t))return "x";
  if(/^(?:utm\s+)?northing(?:s)?\b|^n\s*\((?:m|ft)\)$/.test(t))return "y";
  if(/^(?:(?:(?:ground|land)[ -]surface|surface|ground|collar)\s+(?:elev(?:ation)?\.?|level|r\.?l\.?)|elevation)(?:$|\s*[(\[]|\s+(?:m|metres?|meters?|aod|ahd)\b)/.test(t))return "ground";
  if(/^lat(?:itude)?(?:\.|\b)/.test(t))return "lat";
  if(/^lon(?:g(?:itude)?)?(?:\.|\b)/.test(t))return "lon";
}

function tableLines(lines:readonly TextLine[],page:number){
  const rows:TextLine[][]=[];
  for(const original of [...lines].sort((a,b)=>a.cy-b.cy||a.cx-b.cx)){
    const line={...original,page},row=rows.at(-1),first=row?.[0];
    if(first&&Math.abs(line.cy-first.cy)<=0.52*Math.min(first.y1-first.y0,line.y1-line.y0))row!.push(line);
    else rows.push([line]);
  }
  return rows.map(row=>row.sort((a,b)=>a.cx-b.cx));
}

// Assign each cell to its printed column, including ignored columns such as total depth.
function cells(row:TextLine[],columns:Column[]){
  const groups:TextLine[][]=columns.map(()=>[]);
  for(const cell of row){
    let k=0;
    while(k+1<columns.length&&cell.cx>(columns[k].heading.cx+columns[k+1].heading.cx)/2)k++;
    groups[k].push(cell);
  }
  return groups;
}

function numeric(cell:TextLine,field:CollarField,heading:string){
  // A comma can be either a decimal or a thousands separator. Leave it for manual review.
  const t=(field==="lat"||field==="lon"?cell.text:cell.text.replace(/\s*(?:m|metres?|meters?)$/i,"")).trim();
  const match=t.replace(/−/g,"-").match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:°\s*)?([NSEW])?$/i);
  if(!match)return;
  let value=Number(match[1]);
  const dir=(match[2]??"").toUpperCase();
  if(field==="lat"||field==="lon"){
    const qualifier=heading.match(/(?:\bdegrees?\s+|°\s*|\(\s*|\s+)(north|south|east|west|[NSEW])(?:\s*\)|\s*$)/i)?.[1]?.[0].toUpperCase();
    if(dir&&qualifier&&dir!==qualifier)return;
    const sign=dir||qualifier;
    if(sign){
      if(!(field==="lat"?/^[NS]$/:/^[EW]$/).test(sign)||value<0)return;
      if(sign==="W"||sign==="S")value=-value;
    }
    if(Math.abs(value)>(field==="lat"?90:180))return;
  }else if(dir||cell.text.includes("°"))return;
  return Number.isFinite(value)?value:undefined;
}

interface PrintedCell {heading:TextLine;cell:TextLine;unit?:TextLine}
interface Measurement extends PrintedCell {field:CollarField}
const intended=/\b(?:planned|proposed|pre[ -]drill(?:ing)?|design location|target coordinates?|instructions to (?:the )?drilling contractor)\b/i;
const verticalId=/^(?:bore\s*hole|hole|boring|well|drill\s*hole)\s+(?:id|no\.?|number|identifier)$/i;
const mgazone=/\bMGA\s*(?:zone|z)?\s*(\d{2})\s*S?\b/i;
const gda=/\bGDA\s*(94|2020)\b/i;
const epsg=/\bEPSG\s*:?\s*(\d{4,6})\b/i;
const printedZone=/\b(?:(MGA|UTM)\s*(?:zone|z)?|zone)\s*(\d{1,2})\s*([NS])?\b/gi;
function matchesGridZone(name:string,context:string){
  const gridZone=[...name.matchAll(printedZone)][0];
  return [...context.matchAll(printedZone)].every(([,family,zone,hemisphere])=>{
    if(!gridZone||Number(zone)!==Number(gridZone[2]))return false;
    if(family&&family.toUpperCase()!==gridZone[1]?.toUpperCase())return false;
    const direction=gridZone[3]?.toUpperCase()??(gridZone[1]?.toUpperCase()==="MGA"?"S":undefined);
    return !hemisphere||hemisphere.toUpperCase()===direction;
  });
}
const allCodes=(text:string,re:RegExp)=>[...new Set([...text.matchAll(new RegExp(re.source,"gi"))].map(m=>m[1]))];
function roundingStep(text:string){
  const digits=text.match(/\.(\d+)/)?.[1].length??0;
  return 10**(-digits);
}

// A final drilled length can extend below the last lithology interval. It is a distinct source observation.
function drilledDepth(depths:PrintedCell[],orientation:PrintedCell[],context:TextLine[],notes:string[],rowUnits:string){
  if(!depths.length)return;
  if(depths.length!==1){notes.push("Multiple completed depths were printed for this entry. Check the original borehole record.");return}
  const {heading,cell,unit}=depths[0];
  const units=[heading.text,unit?.text,cell.text,rowUnits,...context.filter(l=>allUnits.test(l.text)).map(l=>l.text)].join(" ");
  const value=numeric(cell,"ground",heading.text);
  if(value===undefined||value<=0||!metre.test(units)||nonMetric.test(units)){
    notes.push(`Verify the completed depth and its units on the printed record (${cell.text}).`);return;
  }
  // Dip or inclination angles require their reference axis. An explicit vertical depth does not.
  if(!/vertical depth/i.test(heading.text)){
    const vertical=(s:string)=>/^(?:none\s*[-–—,;:]\s*)?vertical(?: (?:borehole|hole))?[.!]?$/i.test(s.trim());
    if(orientation.some(o=>!vertical(o.cell.text))){
      notes.push("The schedule gives a borehole orientation that needs interpretation. Verify vertical depth separately from drilled length.");return;
    }
    if(!orientation.length)notes.push("The printed final depth is a drilled length. Check the borehole orientation before treating it as vertical depth.");
  }
  return {value,line:cell,heading};
}

// Interpret row references independently. An unreadable reference must not inherit the table's frame.
function rowFrame(entries:Qualifier[],declaration:string,notes:string[]){
  const codes:string[]=[],statements:string[]=[],checks:Array<(name:string)=>boolean>=[];
  let unknown=false,geographicOnly=false;
  const descriptors=entries.map(e=>e.heading.text+" "+e.cells.map(c=>c.text).join(" ")).join(" ");
  const full=declaration+" "+descriptors;
  const warn=(e:Qualifier)=>{
    unknown=true;
    notes.push(`Verify this row’s ${e.heading.text}: ${e.cells.map(c=>c.text).join(" ")||"(blank)"}. Its position has been withheld.`);
  };
  for(const e of entries){
    if(e.cells.length!==1){warn(e);continue}
    const v=e.cells[0].text.trim(),h=e.heading.text.trim();
    const code=/^(?:EPSG\s*:?\s*)?(\d{4,6})$/i.exec(v)?.[1];
    const named=crsRegistry.find(c=>c.name.toLowerCase()===v.toLowerCase());
    const declaredCode=named?.code.slice(5)??(/epsg|crs|srs|srid|system/i.test(v+" "+h)?code:undefined);
    if(declaredCode){
      const geographicDatum:Record<string,string>={"4326":"WGS84","4283":"GDA94","7844":"GDA2020"};
      const geographic=geographicDatum[declaredCode];
      if(geographic){geographicOnly=true;statements.push(geographic)}
      else if(findCrs(declaredCode))codes.push(declaredCode);
      else warn(e);
      continue;
    }
    const knownDatum=/^(?:GDA\s*(?:94|2020)|WGS\s*[- ]?\s*84|NAD\s*[- ]?\s*(?:27|83))$/i.test(v);
    if(knownDatum){
      statements.push(v);const key=v.toLowerCase().replace(/[^a-z0-9]/g,"");
      checks.push(name=>name.toLowerCase().replace(/[^a-z0-9]/g,"").startsWith(key));continue;
    }
    const zone=v.match(/^(?:(?:MGA|UTM)\s*)?(?:Z(?:one)?\s*)?(\d{1,2})(?:\s*([NS]))?$/i);
    if(zone&&(/\bzone\b/i.test(h)||/^(?:MGA|UTM|zone)/i.test(v))){
      const n=Number(zone[1]),south=zone[2]?.toUpperCase()==="S";
      if(n<1||n>60){warn(e);continue}
      if(/MGA/i.test(full)&&gda.test(full)&&zone[2]?.toUpperCase()!=="N")statements.push(`MGA zone ${n}`);
      else if(/UTM/i.test(full)&&wgs.test(full)&&zone[2])codes.push(String((south?32700:32600)+n));
      else{warn(e);continue}
      checks.push(name=>new RegExp(`zone ${n}(?:[ns])?\\b`,"i").test(name));
      continue;
    }
    warn(e);
  }
  return {codes,statements,checks,unknown,geographicOnly};
}

type Quantity=CollarField|"finalDepth";
function unitApplies(heading:string,field:Quantity){
  const h=heading.toLowerCase();
  if(/depth|drill/.test(h))return field==="finalDepth";
  if(/vertical|height|elev|ground/.test(h))return field==="ground";
  if(/easting/.test(h))return field==="x";
  if(/northing/.test(h))return field==="y";
  if(/latitude/.test(h))return field==="lat";
  if(/longitude/.test(h))return field==="lon";
  if(/coord|horiz|grid|x\s*\/\s*y/.test(h))return field!=="ground"&&field!=="finalDepth";
  return true;
}

// Reduce one printed record to eligible coordinate options. Keep each independent pair intact.
function options(idLine:TextLine,items:Measurement[],context:TextLine[],depths:PrintedCell[],orientation:PrintedCell[],qualifiers:Qualifier[]):CollarScheduleRow[]{
  const fields:CollarScheduleRow["fields"]={},notes:string[]=[];
  const names=items.map(i=>i.field);
  if(new Set(names).size!==names.length)return [];
  if(!(names.includes("x")&&names.includes("y")||names.includes("lat")&&names.includes("lon")))return [];
  const declarations=[...context.map(l=>l.text),...items.map(i=>i.heading.text)].join(" ");
  const refs=qualifiers.filter(q=>q.kind==="frame"),row=rowFrame(refs,declarations,notes);
  const reference=[declarations,...row.statements].join(" ");
  // MGA94 and MGA2020 use different CRSs. The grid zone alone does not establish the datum.
  const datums=allCodes(reference,gda),zones=allCodes(reference,mgazone);
  const codes=[...allCodes(reference,epsg),...row.codes];
  if(datums.length===1&&zones.length===1)codes.push(`${(datums[0]==="94"?28300:7800)+Number(zones[0])}`);
  const grid=codes.length?findCrs(codes[0]):undefined;
  // A row-specific EPSG and a separately printed datum must describe the same frame.
  const datumNames=refs.length?[...reference.matchAll(/\b(?:GDA\s*(?:94|2020)|WGS\s*[- ]?\s*84|NAD\s*[- ]?\s*(?:27|83))\b/gi)].map(m=>m[0].toUpperCase().replace(/[^A-Z0-9]/g,"")):[];
  const gridName=grid?.name.toUpperCase().replace(/[^A-Z0-9]/g,"");
  const incompatible=row.unknown||datums.length>1||zones.length>1||new Set(codes).size>1||
    new Set(datumNames).size>1||!!codes.length&&!grid||!!grid&&(row.geographicOnly||row.checks.some(check=>!check(grid.name))||
    datumNames.some(name=>!gridName?.startsWith(name))||refs.length>0&&!matchesGridZone(grid.name,reference));
  const angles=items.filter(i=>i.field==="lat"||i.field==="lon").map(i=>i.heading.text).join(" ");
  const geoDatum=angles.match(gda)?.[1]??(!wgs.test(reference)&&datums.length===1?datums[0]:undefined);
  const nativeMga=!!geoDatum&&!!grid?.name.startsWith(`GDA${geoDatum} / MGA zone `);
  if(incompatible)notes.push("The schedule names conflicting coordinate reference systems. Verify the survey reference before entering a position.");
  const extra:TextLine[]=qualifiers.flatMap(q=>[q.heading,...q.cells]);
  const units=qualifiers.filter(q=>q.kind==="units"),vertical=qualifiers.filter(q=>q.kind==="verticalDatum");
  const qualifiersFor=(f:Quantity)=>units.filter(q=>unitApplies(q.heading.text,f));
  const unitsText=(f:Quantity)=>qualifiersFor(f).flatMap(q=>q.cells.map(c=>c.text)).join(" ");
  const unitAllowed=(f:Quantity)=>{
    const valid=f==="lat"||f==="lon"?/^(?:decimal )?(?:degrees?|°)$/i:/^(?:m|metres?|meters?)$/i;
    return qualifiersFor(f).every(q=>q.cells.length===1&&valid.test(q.cells[0].text.trim()));
  };
  for(const {field,heading,cell,unit} of items){
    const title=[heading.text,unit?.text].filter(Boolean).join(" ");
    if(unit)extra.push(unit);
    if(!unitAllowed(field)){
      extra.push(heading,cell);notes.push(`Verify the row-specific units for ${heading.text} (${unitsText(field)||"blank"}).`);continue;
    }
    if(field==="ground"&&vertical.length){
      extra.push(heading,cell);notes.push("Verify the row-specific vertical datum against the project before entering this elevation.");continue;
    }
    if(field==="ground"&&/ellipsoid/i.test(title)){
      notes.push(`Printed ${heading.text}: ${cell.text}. Enter a separately verified ground elevation for the model's vertical datum.`);
      extra.push(heading,cell);continue;
    }
    const value=numeric(cell,field,title);
    if(value===undefined){extra.push(heading,cell);continue}
    if(field!=="ground"&&(incompatible||(field==="x"||field==="y")&&refs.length&&!grid)){
      extra.push(heading,cell);notes.push("Verify the printed coordinate reference for this row before using its position.");continue;
    }
    if(field==="lat"||field==="lon"){
      if(geoDatum?(!nativeMga||wgs.test(angles)):!wgs.test(reference)){
        extra.push(heading,cell);notes.push("Verify the geographic datum before using the latitude and longitude.");continue;
      }
    }else{
      const scope=context.filter(l=>allUnits.test(l.text)||field!=="ground"&&coordinateUnits.test(l.text));
      const units=[title,cell.text,unitsText(field),...scope.map(l=>l.text)].join(" ");
      if(nonMetric.test(units)||!(metre.test(units)||field!=="ground"&&grid)){
        extra.push(heading,cell);notes.push(`The units of “${heading.text}” need checking before entry in metres.`);continue;
      }
    }
    fields[field]={value,line:cell,heading};
  }
  if(!(fields.x&&fields.y||fields.lat&&fields.lon))notes.push("No complete position with supported units and reference was read. Check the printed coordinate cells.");
  if(fields.x&&fields.y&&!grid)notes.push("Confirm the horizontal coordinate system under Project before georeferencing these coordinates.");
  if(fields.ground)notes.push("Confirm that this ground elevation uses the project's vertical datum.");
  if(depths.length&&!unitAllowed("finalDepth"))notes.push("Verify the row-specific depth units before using the drilled length.");
  const finalDepth=unitAllowed("finalDepth")?drilledDepth(depths,orientation,context,notes,unitsText("finalDepth")):undefined;
  if(depths.length)for(const entry of [...depths,...orientation])extra.push(entry.heading,entry.cell,...(entry.unit?[entry.unit]:[]));
  const base:CollarScheduleRow={...(finalDepth?{finalDepth}:{}),id:idLine.text.trim(),idLine,page:idLine.page!,fields:{},context:[...context,...extra],
    notes:[...new Set([...notes,...context.map(l=>l.text)])],...(grid&&!incompatible?{crsCode:grid.code}:{})};
  if(names.includes("x")&&names.includes("y")&&names.includes("lat")&&names.includes("lon")&&
    !(fields.x&&fields.y&&fields.lat&&fields.lon)){
    base.coordinateConflict=true;
    base.notes.push("The sheet gives two coordinate representations and one cannot be verified. Review the printed pairs.");
    base.context=[...base.context??[],...items.filter(i=>i.field!=="ground").flatMap(i=>[i.heading,i.cell])];
  }
  if(fields.ground)base.fields.ground=fields.ground;
  const alternatives:CollarScheduleRow[]=[];
  if(fields.x&&fields.y)alternatives.push({...base,coordinateKind:"projected",fields:{...base.fields,x:fields.x,y:fields.y}});
  if(fields.lat&&fields.lon){
    const geo:CollarScheduleRow={...base,coordinateKind:"geographic",fields:{...base.fields,lat:fields.lat,lon:fields.lon}};
    if(grid){
      // GDA94 / GDA2020 geographic and their respective MGA projected frames share GRS80.
      // Project the source angles within that datum without a transformation to WGS84.
      if(nativeMga){
        const [x,y]=proj4("+proj=longlat +ellps=GRS80 +no_defs",grid.proj4,[fields.lon.value,fields.lat.value]);
        geo.projectedFromGeographic={x,y};
      }else geo.projectedFromGeographic=toProjected(grid,fields.lon.value,fields.lat.value);
      if(!Object.values(geo.projectedFromGeographic).every(Number.isFinite))return alternatives;
    }
    if(alternatives.length){
      const at=geo.projectedFromGeographic;
      let difference:string;
      if(at&&fields.x&&fields.y){
        const offset=Math.hypot(at.x-fields.x.value,at.y-fields.y.value);
        // The printed coordinate resolutions bound the distance caused by rounding alone.
        const angular=Math.hypot(roundingStep(fields.lat.line.text),roundingStep(fields.lon.line.text)*Math.cos(fields.lat.value*Math.PI/180));
        const tolerance=(Math.hypot(roundingStep(fields.x.line.text),roundingStep(fields.y.line.text))+112000*angular)/2;
        if(offset<=tolerance)return alternatives;
        difference=`The printed grid and geographic positions differ by ${offset.toFixed(2)} m in ${grid!.name}, beyond their printed precision.`;
      }else difference="The grid and geographic positions have no verified common coordinate system.";
      for(const candidate of [...alternatives,geo]){
        candidate.coordinateConflict=true;
        candidate.notes=[...candidate.notes,difference,"Choose the position to use after checking both sources."];
        candidate.context=[...candidate.context??[],...items.filter(i=>i.field!=="ground").flatMap(i=>[i.heading,i.cell])];
      }
    }
    alternatives.push(geo);
  }
  return alternatives.length?alternatives:[base];
}

function extractRow(row:TextLine[],columns:Column[],context:TextLine[]){
  const values=cells(row,columns),id=values[columns.findIndex(c=>c.label==="id")];
  if(id.length!==1||!id[0].text.trim()||id[0].text.trim().length>80)return [];
  const items:Measurement[]=[],depths:PrintedCell[]=[],orientation:PrintedCell[]=[];
  for(const [k,column] of columns.entries()){
    if(column.label&&column.label!=="id"&&values[k].length===1){
      const cell=values[k][0];
      if(column.label==="finalDepth"||column.label==="orientation"){
        (column.label==="finalDepth"?depths:orientation).push({heading:column.heading,unit:column.unit,cell});continue;
      }
      if(/^[+−-]?(?:\d|\.\d)|^(?:[−–—-]|N\/?A|unknown|unavailable)$/i.test(cell.text.trim())){
        items.push({field:column.label,heading:column.heading,unit:column.unit,cell});
      }
    }
  }
  const qualifiers=columns.flatMap((c,k)=>c.qualifier?[{kind:c.qualifier,heading:c.heading,cells:values[k]}]:[]);
  return options(id[0],items,context,depths,orientation,qualifiers);
}

// Some completion records present one collar as a two-column form with its coordinate alternatives underneath.
function verticalRecord(rows:TextLine[][],start:number){
  const first=rows[start];
  if(first.length!==2||!verticalId.test(first[0].text.trim()))return [];
  const idLine=first[1],items:Measurement[]=[],context:TextLine[]=[],depths:PrintedCell[]=[],orientation:PrintedCell[]=[];
  const qualifiers:Qualifier[]=[];
  let positionComplete=false;
  const h=first[0].y1-first[0].y0;
  for(let j=start+1;j<rows.length;j++){
    const row=rows[j];
    if(row[0].cy-rows[j-1][0].cy>4*h||row.some(l=>intended.test(l.text)))break;
    // The next ID starts another record. A Site ID can be an alias within a borehole entry.
    if(verticalId.test(row[0].text.trim()))break;
    const kind=qualifier(row[0].text);
    if(kind){qualifiers.push({kind,heading:row[0],cells:row.slice(1)});continue}
    const k=row.findIndex(l=>{const name=label(l.text);return name&&name!=="id"});
    if(k<0){
      if(items.length){
        positionComplete=true;
        // Metadata after the position can include the actual drilled length and a deviation survey.
        // Restrict it to the same two-column form and stop at another heading or the page footer.
        if(row.length!==2||Math.abs(row[0].x0-first[0].x0)>h||Math.abs(row[1].x0-first[1].x0)>h)break;
      }
      continue;
    }
    const heading=row[k],cell=row[k+1],field=label(heading.text);
    if(!field||field==="id"||!cell||row.length!==k+2)break;
    if(field==="finalDepth"||field==="orientation"){
      if(Math.abs(heading.x0-first[0].x0)>h||Math.abs(cell.x0-first[1].x0)>h)break;
      (field==="finalDepth"?depths:orientation).push({heading,cell});continue;
    }
    if(positionComplete||numeric(cell,field,heading.text)===undefined)break;
    items.push({field,heading,cell});
    if(datum.test(heading.text)||mgazone.test(heading.text))context.push(heading);
  }
  return options(idLine,items,context,depths,orientation,qualifiers);
}

export function readCollarSchedules(pages:readonly {page:number;lines:readonly TextLine[]}[]):CollarScheduleRow[]{
  const findings:CollarScheduleRow[]=[];
  for(const page of pages){
    const rows=tableLines(page.lines,page.page);
    for(let i=0;i<rows.length;i++){
      const headers=rows[i],surrounding=rows.slice(Math.max(0,i-4),i+1).flat();
      if(surrounding.some(l=>intended.test(l.text)))continue;
      findings.push(...verticalRecord(rows,i));
      const columns=headers.map((heading):Column=>{
        const role=qualifier(heading.text);
        return role?{heading,qualifier:role}:{heading,label:label(heading.text)};
      });
      const labels=columns.flatMap(c=>c.label&&c.label!=="finalDepth"&&c.label!=="orientation"?[c.label]:[]);
      if(!labels.includes("id")||!(labels.includes("x")&&labels.includes("y")||labels.includes("lat")&&labels.includes("lon"))||
        new Set(labels).size!==labels.length)continue;
      const h=Math.max(...headers.map(l=>l.y1-l.y0)),context=rows.slice(Math.max(0,i-4),i).flat().filter(l=>
        headers[0].cy-l.cy<7*h&&(datum.test(l.text)||mgazone.test(l.text)||/^zone\s+\d+\s*[NS]?$/i.test(l.text.trim())||coordinateUnits.test(l.text)||allUnits.test(l.text)));
      let start=i+1;
      // A second heading line often contains only units. Retain its original box for review.
      const second=rows[start];
      if(second&&second[0].cy-headers[0].cy<2.4*h&&second.every(l=>/^\s*\(?\s*(?:m|ft|feet|metres?|meters?|degrees?|°|[NSEW]|ID|no\.?)\s*\)?\s*$/i.test(l.text))){
        const parts=cells(second,columns);
        columns.forEach((c,k)=>{if(parts[k].length===1)c.unit=parts[k][0]});
        start++;
      }
      let previous=rows[start-1][0].cy;
      for(let j=start;j<rows.length;j++){
        const row=rows[j];
        if(row[0].cy-previous>4*h)break;
        if(row.some(l=>intended.test(l.text))){previous=row[0].cy;continue}
        const entry=extractRow(row,columns,context);
        if(!entry.length)break;
        findings.push(...entry);
        previous=row[0].cy;
      }
    }
  }
  return findings;
}

// Run separately for each source document. A repeated identifier is a decision even if repeated values agree.
export function matchCollarSchedules(logs:readonly ReadLog[],rows:readonly CollarScheduleRow[]):CollarScheduleMatch[]{
  const byId=new Map<string,CollarScheduleRow[]>(),counts=new Map<string,number>();
  for(const row of rows){
    const group=byId.get(row.id);
    if(group)group.push(row);else byId.set(row.id,[row]);
  }
  for(const log of logs)if(log.id&&log.src?.id)counts.set(log.id.trim(),(counts.get(log.id.trim())??0)+1);
  return logs.map(log=>{
    const id=log.id?.trim(),candidates=id&&log.src?.id?byId.get(id)??[]:[];
    if(!candidates.length)return {status:"missing",candidates,notes:[]};
    if(counts.get(id!)===1&&candidates.length===2&&candidates.every(c=>c.coordinateConflict)&&candidates[0].idLine===candidates[1].idLine){
      return {status:"conflict",candidates,notes:candidates[0].notes};
    }
    if(candidates.length>1||counts.get(id!)!==1)return {status:"ambiguous",candidates,
      notes:["This identifier occurs on multiple schedule rows or logs. Review the source before assigning a collar."]};
    const row=candidates[0],fields=row.fields,notes=[...row.notes];
    if(row.coordinateConflict||!(fields.x&&fields.y||fields.lat&&fields.lon))return {status:"conflict",candidates,notes};
    let missing=false,disagrees=false;
    for(const f of dimensions){
      if(!fields[f])continue;
      if(log[f]===undefined)missing=true;
      else if(log[f]!==fields[f].value){disagrees=true;notes.push(`The log and the schedule give different values for ${f}.`)}
    }
    if(fields.x&&fields.y&&log.lat!==undefined&&log.lon!==undefined&&(log.x===undefined||log.y===undefined)||
       fields.lat&&fields.lon&&log.x!==undefined&&log.y!==undefined&&(log.lat===undefined||log.lon===undefined)){
      disagrees=true;notes.push("The log uses another coordinate representation. Verify the positions in a common reference system.");
    }
    return {status:disagrees?"conflict":missing?"proposed":"confirmed",candidates,notes};
  });
}
