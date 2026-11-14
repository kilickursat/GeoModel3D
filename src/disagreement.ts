// A conditional envelope of explicitly selected interpretations, sampled at common world coordinates. These
// alternatives do not form a probability distribution; missing members never become a narrower or zero range.
import type {Alignment,GeoProject} from "./schema";
import {buildGeologicalModel,GeoModel,modelBounds,sampleModel} from "./model";
import {computeSection,offsetThrough,principalAzimuth,sectionRuns,Section} from "./section";
import {alignmentProblem,alignmentSection,chainages,pointAt} from "./alignment";
import {compatibleCrs} from "./comparison";
import {projectCrs} from "./crs";
import {toCsv} from "./io";

export interface DisagreementCase { id:string;label?:string;project:GeoProject }
export interface PreparedDisagreementCase { id:string;label?:string;name:string;model:GeoModel }
export interface DisagreementOptions {
  unitId:string;mode:"section"|"alignment";alignment?:Alignment;azimuth?:number;offset?:number;
  step?:number;gridSize?:number;maxSamples?:number;
}
export interface DisagreementSample {
  x:number;y:number;count:number;total:number;complete:boolean;reference?:number;min?:number;max?:number;width?:number;
  values:{caseId:string;elevation?:number}[];missingCaseIds:string[];
}
export interface DisagreementReport {
  format:"geomodel3d-disagreement";version:1;cases:{id:string;label?:string;name:string}[];
  surface:{unitId:string;name:string};surfaces:{unitId:string;name:string;presentCaseIds:string[]}[];
  options:{unitId:string;mode:"section"|"alignment";step:number;gridSize:number;maxSamples:number;azimuth?:number;offset?:number;alignment?:Alignment};
  path:{mode:"section"|"alignment";axisLabel:"Distance (m)"|"Chainage (m)";start:number;end:number;actualStep:number;
    origin?:{x:number;y:number};dir?:{x:number;y:number};azimuth?:number;offset?:number;alignment?:Alignment};
  grid:{size:number;minX:number;maxX:number;minY:number;maxY:number;points:DisagreementSample[]};
  points:(DisagreementSample&{distance:number})[];
  summary:{gridCount:number;pathCount:number;completeGridCount:number;completePathCount:number;maxGridWidth?:number;maxPathWidth?:number};
  notes:string[];
}
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
type Range=[number,number];
const unique=(values:number[])=>values.sort((a,b)=>a-b).filter((n,i,all)=>i===0||n-all[i-1]>1e-8);
const ranges=(section:Section):Range[]=>sectionRuns(section).map(([a,b])=>[section.s[a],section.s[b]] as Range).filter(([a,b])=>finite(a)&&finite(b));
const covered=(runs:Range[],at:number)=>runs.some(([a,b])=>at>=a-1e-8&&at<=b+1e-8);
const indices=new WeakMap<GeoModel,Map<string,number>>();

export function prepareDisagreementModels(cases:DisagreementCase[]):PreparedDisagreementCase[]{
  if(cases.length<2||cases.length>6)throw new Error("Select two to six saved interpretations for a disagreement range.");
  if(cases.some(c=>typeof c.id!=="string"||!c.id.trim())||new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error("Interpretation IDs must be nonempty and unique.");
  for(const item of cases){
    compatibleCrs(cases[0].project,item.project);
    if(new Set(item.project.units.map(u=>u.id)).size!==item.project.units.length)throw new Error(`${item.project.name}: unit IDs must be unique for disagreement analysis.`);
  }
  return cases.map(c=>({id:c.id,...(c.label===undefined?{}:{label:c.label}),name:c.project.name,model:buildGeologicalModel(c.project)}));
}

export function sampleDisagreement(models:PreparedDisagreementCase[],x:number,y:number,unitId:string):DisagreementSample{
  if(!finite(x)||!finite(y))throw new Error("Disagreement sample coordinates must be finite.");
  const values=models.map(({id:caseId,model})=>{
    let lookup=indices.get(model);if(!lookup){lookup=new Map(model.units.map((u,k)=>[u.id,k]));indices.set(model,lookup)}
    const k=lookup.get(unitId),value=k===undefined?undefined:sampleModel(model,x,y)?.[k];
    return {caseId,...(finite(value)?{elevation:value}:{})};
  });
  const elevations=values.flatMap(v=>v.elevation===undefined?[]:[v.elevation]);
  const complete=models.length>=2&&elevations.length===models.length;
  return {x,y,count:elevations.length,total:models.length,complete,...(values[0]?.elevation===undefined?{}:{reference:values[0].elevation}),
    ...(complete?{min:Math.min(...elevations),max:Math.max(...elevations),width:Math.max(...elevations)-Math.min(...elevations)}:{}),
    values,missingCaseIds:values.filter(v=>v.elevation===undefined).map(v=>v.caseId)};
}

export function buildDisagreement(cases:DisagreementCase[],options:DisagreementOptions):DisagreementReport{
  if(options.mode!=="section"&&options.mode!=="alignment")throw new Error("Choose a straight section or a reference alignment.");
  if(typeof options.unitId!=="string"||!options.unitId.trim())throw new Error("Choose a geological unit ID for the contact range.");
  const step=options.step??10,size=options.gridSize??15,cap=options.maxSamples??501;
  if(!finite(step)||step<=0)throw new Error("The path spacing must be a positive finite number.");
  if(!Number.isInteger(size)||size<2||size>25)throw new Error("The map grid size must be an integer from 2 to 25.");
  if(!Number.isInteger(cap)||cap<2||cap>501)throw new Error("The path sample limit must be an integer from 2 to 501.");
  for(const key of ["azimuth","offset"] as const)if(options[key]!==undefined&&!finite(options[key]))throw new Error(`The section ${key} must be finite.`);
  if(options.mode==="alignment"){
    if(!options.alignment)throw new Error("Choose an explicit reference alignment.");
    const problem=alignmentProblem(options.alignment);if(problem)throw new Error(`The reference alignment is invalid: ${problem}.`);
  }
  const models=prepareDisagreementModels(cases),footprints=models.filter(c=>c.model.triangles.length&&c.model.nodes.length);
  if(!footprints.length)throw new Error("The selected interpretations have no usable model footprints.");
  const definitions=new Map<string,string>();for(const c of cases)for(const u of c.project.units)if(!definitions.has(u.id))definitions.set(u.id,u.name);
  const surfaces=[...definitions].map(([unitId,name])=>({unitId,name,presentCaseIds:models.filter(c=>c.model.units.some(u=>u.id===unitId)).map(c=>c.id)}));
  const definition=surfaces.find(s=>s.unitId===options.unitId);if(!definition)throw new Error("The selected contact ID is not declared in these interpretations.");
  const bounds=footprints.map(c=>modelBounds(c.model));
  const minX=Math.min(...bounds.map(b=>b.minX)),maxX=Math.max(...bounds.map(b=>b.maxX)),minY=Math.min(...bounds.map(b=>b.minY)),maxY=Math.max(...bounds.map(b=>b.maxY));
  if(![minX,maxX,minY,maxY].every(finite)||!(maxX>minX)||!(maxY>minY))throw new Error("The selected footprints do not define a usable map extent.");
  const gridPoints=Array.from({length:size*size},(_,i)=>sampleDisagreement(models,minX+(maxX-minX)*(i%size)/(size-1),minY+(maxY-minY)*Math.floor(i/size)/(size-1),options.unitId));
  const path:DisagreementReport["path"]={mode:options.mode,axisLabel:options.mode==="section"?"Distance (m)":"Chainage (m)",start:0,end:0,actualStep:0};
  const normal:DisagreementReport["options"]={unitId:options.unitId,mode:options.mode,step,gridSize:size,maxSamples:cap};
  const notes=["The range is the minimum and maximum contact elevation across the selected interpretations. It is conditional on this explicit selection, not a confidence interval or a probability distribution.",
    "Contacts are tops of stable unit IDs, not names or array positions. An envelope is available only when every selected interpretation has a finite model value for that contact at the same coordinates.",
    "The first interpretation is the reference. Its values remain identifiable even where other interpretations have missing coverage or omit the selected contact.",
    "All elevations use the supplied datum. Confirm a common vertical datum and project-coordinate origin, orientation and units; the file format cannot verify them.",
    "Map values and path extrema describe sampled locations. Conditions between samples may be missed; displayed bands join sampled envelopes and are not exact continuous extrema.",
    "Selected projects are rebuilt with the current engine. Their saved engine versions describe the original revisions, not separate historical execution environments."];
  if(!projectCrs(cases[0].project))notes.push("These projects use a local or unrecognised grid. Matching grid names do not establish a common physical reference.");
  let start:number,end:number,allRanges:Range[][],at:(s:number)=>{x:number;y:number},required:number[];
  if(options.mode==="section"){
    const reference=models[0].model,azimuth=options.azimuth??principalAzimuth(reference),offset=options.offset??0;
    const first=computeSection(reference,{azimuth,offset});
    if(first.s.length<2||!ranges(first).some(([a,b])=>b-a>1e-8))throw new Error("The reference section does not cross the first interpretation over a usable length.");
    const along=(x:number,y:number)=>(x-first.origin.x)*first.dir.x+(y-first.origin.y)*first.dir.y;
    allRanges=models.map(({model},index)=>{
      if(!model.triangles.length)return [];
      const s=index===0?first:computeSection(model,{azimuth,offset:offsetThrough(model,azimuth,first.origin)});
      return ranges({...s,s:s.x.map((x,i)=>along(x,s.y[i]))});
    });
    const ends=allRanges.flat(2);start=Math.min(...ends);end=Math.max(...ends);
    at=s=>({x:first.origin.x+s*first.dir.x,y:first.origin.y+s*first.dir.y});
    path.origin={...first.origin};path.dir={...first.dir};path.azimuth=azimuth;path.offset=offset;normal.azimuth=azimuth;normal.offset=offset;
    required=[start,end,...allRanges.flat(2)];
    notes.push("The straight section is fixed in the first interpretation's world-coordinate frame and extended along that same line across the selected footprints.");
  }else{
    const alignment=options.alignment!,ch=chainages(alignment);start=ch[0];end=ch[ch.length-1];
    allRanges=models.map(({model})=>model.triangles.length?ranges(alignmentSection(model,alignment)):[]);
    at=s=>pointAt(alignment,s,ch);path.alignment=structuredClone(alignment);normal.alignment=structuredClone(alignment);
    required=[start,end,...ch,...(alignment.design??[]).map(d=>d.chainage).filter(c=>c>=start&&c<=end),...allRanges.flat(2)];
    notes.push("All interpretations use the same reference alignment geometry and supplied chainages. Chainage span need not equal physical path length.");
  }
  if(!finite(start)||!finite(end)||!finite(end-start)||end-start<=1e-8)throw new Error("The reference path has no usable finite range.");
  const boundaries=unique([start,end,...allRanges.flat(2)].filter(c=>c>=start&&c<=end));
  for(let i=1;i<boundaries.length;i++){
    const mid=(boundaries[i-1]+boundaries[i])/2;if(allRanges.some(r=>!covered(r,mid)))required.push(mid);
  }
  const mandatory=unique(required.filter(c=>c>=start&&c<=end));
  if(mandatory.length>cap)throw new Error("The path sample limit is too small to retain alignment vertices, design knots and model gaps. Increase it or simplify the reference path.");
  const segments=Math.max(1,Math.min(Math.ceil((end-start)/step),cap-mandatory.length+1)),actualStep=(end-start)/segments;
  const positions=unique([...mandatory,...Array.from({length:segments-1},(_,i)=>start+(i+1)*actualStep)]);
  const points=positions.map(distance=>{const xy=at(distance);return {...sampleDisagreement(models,xy.x,xy.y,options.unitId),distance}});
  path.start=start;path.end=end;path.actualStep=actualStep;
  if(actualStep>step*(1+1e-9))notes.push(`The regular path spacing increased from ${step} to ${actualStep} to stay within ${cap} samples; required boundaries and gaps were retained.`);
  const maxWidth=(samples:DisagreementSample[])=>{const values=samples.flatMap(p=>p.width===undefined?[]:[p.width]);return values.length?Math.max(...values):undefined};
  const maxGridWidth=maxWidth(gridPoints),maxPathWidth=maxWidth(points);
  if(!gridPoints.some(p=>p.complete))notes.push("No map-grid locations have a complete envelope across all selected interpretations.");
  if(!points.some(p=>p.complete))notes.push("No reference-path locations have a complete envelope across all selected interpretations.");
  notes.push(...models.flatMap(c=>c.model.warnings.map(w=>`${c.label??c.name} (${c.id}): ${w}`)));
  return {format:"geomodel3d-disagreement",version:1,cases:models.map(({id,label,name})=>({id,...(label===undefined?{}:{label}),name})),
    surface:{unitId:options.unitId,name:definition.name},surfaces,options:normal,path,grid:{size,minX,maxX,minY,maxY,points:gridPoints},points,
    summary:{gridCount:gridPoints.length,pathCount:points.length,completeGridCount:gridPoints.filter(p=>p.complete).length,completePathCount:points.filter(p=>p.complete).length,
      ...(maxGridWidth===undefined?{}:{maxGridWidth}),...(maxPathWidth===undefined?{}:{maxPathWidth})},notes};
}

export function disagreementCsv(report:DisagreementReport):string{
  const headers=["sample_type","distance_m","x_m","y_m","complete","available_case_count","selected_case_count","reference_elevation_m","min_elevation_m","max_elevation_m","range_width_m","missing_case_ids",...report.cases.map(c=>`case_${c.id}_elevation_m`),"unit_id","unit_name","selected_cases","path_mode","path_settings","map_grid_settings","review_notes"];
  const metadata=[report.surface.unitId,report.surface.name,JSON.stringify(report.cases),report.path.mode,JSON.stringify(report.path),JSON.stringify({size:report.grid.size,minX:report.grid.minX,maxX:report.grid.maxX,minY:report.grid.minY,maxY:report.grid.maxY}),JSON.stringify(report.notes)];
  const row=(kind:string,sample:DisagreementSample,distance?:number)=>[kind,distance,sample.x,sample.y,String(sample.complete),sample.count,sample.total,sample.reference,sample.min,sample.max,sample.width,JSON.stringify(sample.missingCaseIds),...report.cases.map(c=>sample.values.find(v=>v.caseId===c.id)?.elevation),...metadata];
  return toCsv([headers,...report.grid.points.map(p=>row("map",p)),...report.points.map(p=>row("path",p,p.distance))]);
}
