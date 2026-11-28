import {applyBedAssignments,type BedAssignment} from "./bedAssignments";
import type {GeoProject} from "./schema";
import {projectFromTables,tablesFromProject,type EditorTables} from "./tables";

const intervalKey=(hole:string,from:number,to:number)=>JSON.stringify([hole,from,to]);
const depth=(text:string|undefined)=>text?.trim()?Number(text.trim().replace(",",".")):NaN;

/** Patch the current draft's reviewed cells. Replacing the entire draft with parsed tables would discard unfinished rows. */
export function applyBedReviewToDraft(draft:EditorTables,base:GeoProject|undefined,decisions:readonly BedAssignment[]):EditorTables{
  if(!decisions.length)return draft;
  const before=projectFromTables(draft,base).project;
  const after=applyBedAssignments(before,decisions);
  if(after===before)return draft;

  const byInterval=new Map(decisions.map(d=>[intervalKey(d.holeId,d.from,d.to),d])),matched=new Set<string>();
  const logs=draft.rows.logs.map(row=>{
    const key=intervalKey(row[0]?.trim()??"",depth(row[1]),depth(row[2]));
    const d=byInterval.get(key);
    if(!d)return row;
    if(matched.has(key))throw new Error(`The draft contains duplicate log rows for ${d.holeId} at ${d.from}–${d.to} m.`);
    matched.add(key);
    const bed=row[3]?.trim();
    if(bed!==d.expectedBed&&bed!==d.bedId)throw new Error(`The draft bed for ${d.holeId} at ${d.from}–${d.to} m changed. Check the log before applying the review.`);
    if(bed===d.bedId)return row;
    const updated=[...row];updated[3]=d.bedId;return updated;
  });
  if(matched.size!==byInterval.size)throw new Error("Some reviewed intervals could not be matched to the draft log rows.");

  // Existing unit rows may contain raw property text and evidence references. Move those rows together;
  // only newly defined or implicitly inferred beds need rows made from the validated model definitions.
  const definitions=tablesFromProject({name:after.name,units:after.units,boreholes:[]});
  const original=new Map(draft.rows.units.flatMap((row,i)=>row[0]?.trim()?[[row[0].trim(),i] as const]:[]));
  if(original.size!==draft.rows.units.filter(row=>row[0]?.trim()).length)throw new Error("The draft contains duplicate bed identifiers. Check the Units table before applying the review.");
  const refs=draft.evidenceRows?.units;
  const ordered=definitions.rows.units.map(row=>{
    const i=original.get(row[0]);original.delete(row[0]);
    return i===undefined?{row,ref:null}:{row:draft.rows.units[i],ref:refs?.[i]??null};
  });
  if(original.size)throw new Error("Some draft bed definitions could not be matched to the interpreted order.");
  // Unnamed or unfinished rows keep their positions among the ordered named rows.
  let i=0;
  const entries=draft.rows.units.map((row,index)=>row[0]?.trim()?ordered[i++]:{row,ref:refs?.[index]??null});
  entries.push(...ordered.slice(i));
  return {...draft,rows:{...draft.rows,logs,units:entries.map(e=>e.row)},bedAssignments:after.bedAssignments,
    ...(after.evidence?{evidence:after.evidence}:{}),
    ...(definitions.extraUnitParams?{extraUnitParams:{...draft.extraUnitParams,...definitions.extraUnitParams}}:{}),
    ...(refs?{evidenceRows:{...draft.evidenceRows,units:entries.map(e=>e.ref)}}:{})};
}
