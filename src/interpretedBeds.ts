import {COLUMNS,projectFromTables,tablesFromProject,type EditorTables} from "./tables";
import {changeEvidenceField,evidenceRecord} from "./evidence";

const materialColumn=COLUMNS.units.findIndex(c=>c.csv==="material_id");
const materialOf=(row:string[])=>row[materialColumn]?.trim()||row[0].trim();
const asDepth=(value:string)=>value.trim()?Number(value.trim().replace(",",".")):NaN;

export function interpretedBedOptions(tables:EditorTables,sourceUnit:string):string[]{
  const rows=tables.rows.units;
  const source=rows.find(r=>r[0].trim()===sourceUnit);
  const material=source?materialOf(source):sourceUnit;
  const options=rows.filter(r=>r[0].trim()&&materialOf(r)===material).map(r=>r[0].trim());
  return [...new Set(source?options:[sourceUnit,...options])];
}

// A bed assignment is an interpretation of a particular measured interval. Retain
// its original description, depths, material group and source-evidence history.
export function assignInterpretedBed(tables:EditorTables,
  source:{holeId:string;from:number;to:number;unit:string;kind?:"borehole"|"cpt"},
  target:{id:string;beforeUnit?:string|null}){
  if(source.kind==="cpt")throw new Error("CPT layers must be edited in the CPT interpretation.");
  const matches=tables.rows.logs.filter(r=>r[0].trim()===source.holeId&&asDepth(r[1])===source.from&&asDepth(r[2])===source.to&&r[3].trim()===source.unit);
  if(matches.length!==1)throw new Error("The selected interval changed or is ambiguous. Refresh the correlation review.");
  const id=target.id.trim();
  if(!id)throw new Error("Enter a bed identifier.");
  if(id===source.unit)throw new Error("Choose a different bed for this interval.");

  // A log may introduce units absent from the explicit Units table. Materialize
  // their existing inferred order before inserting a new bed into it.
  const units=[...tables.rows.units];
  const declared=units.map(r=>r[0].trim()).filter(Boolean);
  const ids=new Set(declared);
  if(ids.size!==declared.length)throw new Error("The units table has duplicate bed identifiers.");
  const links=tables.evidenceRows?.units?.slice();
  if(links&&links.length!==units.length)throw new Error("Unit evidence does not match the draft rows.");
  if(tables.rows.logs.some(r=>r[3].trim()&&!ids.has(r[3].trim()))){
    const inferred=tablesFromProject(projectFromTables(tables).project).rows.units;
    for(const row of inferred)if(!ids.has(row[0])){
      units.push(row);ids.add(row[0]);links?.push(null);
    }
  }
  const original=units.find(r=>r[0].trim()===source.unit);
  if(!original)throw new Error("The selected interval has no unit definition.");
  const material=materialOf(original);
  const existing=units.find(r=>r[0].trim()===id);
  if(target.beforeUnit===undefined){
    if(!existing||materialOf(existing)!==material)throw new Error("Choose an existing bed of the same material.");
  }else{
    if(existing||units.some(r=>r[materialColumn]?.trim()===id))throw new Error("That bed identifier is already in use.");
    const position=target.beforeUnit===null?units.length:units.findIndex(r=>r[0].trim()===target.beforeUnit);
    if(position<0)throw new Error("The selected position is no longer in the unit order.");
    const bed=[...original];
    bed[0]=id;bed[1]=id;bed[materialColumn]=material;
    units.splice(position,0,bed);
    links?.splice(position,0,null);
  }
  const row=matches[0],index=tables.rows.logs.indexOf(row);
  const evidence=evidenceRecord(tables.evidence,tables.evidenceRows?.logs?.[index]??undefined);
  if(evidence)changeEvidenceField(evidence,"unit",id,`Assigned interpreted bed for logged material ${material}`);
  if(!existing&&tables.extraUnitParams&&Object.hasOwn(tables.extraUnitParams,source.unit)){
    tables.extraUnitParams={...tables.extraUnitParams,[id]:{...tables.extraUnitParams[source.unit]}};
  }
  row[3]=id;
  tables.rows.units=units;
  if(links&&tables.evidenceRows)tables.evidenceRows.units=links;
}
