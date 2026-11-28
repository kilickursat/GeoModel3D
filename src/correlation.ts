// Agreement at the contributing collars measures the fit to the source logs. Holdout prediction is measured separately.
import type {GeoModel} from "./model";
import type {Borehole} from "./schema";

interface LoggedInterval {
  holeId:string;
  kind:"borehole"|"cpt";
  /** Index in the source borehole intervals or CPT layers, before any filtering. */
  intervalIndex:number;
  /** Original depth range in metres below the collar or CPT start level. */
  from:number;
  to:number;
  unit:string;
}

export interface CollarDiscrepancy extends LoggedInterval {
  mismatchFrom:number;
  mismatchTo:number;
  modelledUnit:string|null;
  reason:"different-unit"|"outside-coverage"|"no-solids";
}

interface AgreementMetres {
  loggedMetres:number;
  matchedMetres:number;
  /** Material represented by a different unit within the solid model. */
  mismatchedMetres:number;
  /** Logged material outside the vertical coverage of the model or without a solid model. */
  unknownMetres:number;
}

export interface CollarIntervalAgreement extends LoggedInterval,AgreementMetres {
  discrepancies:CollarDiscrepancy[];
}

export interface CollarAgreementAudit extends AgreementMetres {
  status:"modelled"|"logs-only";
  intervals:CollarIntervalAgreement[];
  discrepancies:CollarDiscrepancy[];
}

interface ModelBand {from:number;to:number;unit:string}

// Contributing logs occupy the first nodes of the completed mesh, even after refinement. Use the actual
// ordered and clipped horizon elevations there, including the model base.
function columnAt(model:GeoModel,node:number,collar:number):ModelBand[]{
  const bands:ModelBand[]=[];
  for(let k=0;k<model.units.length;k++){
    const from=collar-model.horizons[k].z[node],to=collar-model.horizons[k+1].z[node];
    if(Number.isFinite(from)&&Number.isFinite(to)&&to>from)bands.push({from,to,unit:model.units[k].id});
  }
  return bands;
}

function compareInterval(source:LoggedInterval,bands:ModelBand[],hasSolids:boolean,collar:number):CollarIntervalAgreement{
  const {from,to,unit}=source;
  const row:CollarIntervalAgreement={...source,loggedMetres:to-from,matchedMetres:0,mismatchedMetres:0,unknownMetres:0,discrepancies:[]};
  let cursor=from;
  const record=(end:number,modelledUnit:string|null)=>{
    if(end<=cursor)return;
    const length=end-cursor;
    if(modelledUnit===unit)row.matchedMetres+=length;
    else{
      if(modelledUnit===null)row.unknownMetres+=length;
      else row.mismatchedMetres+=length;
      const reason=modelledUnit!==null?"different-unit":hasSolids?"outside-coverage":"no-solids";
      row.discrepancies.push({...source,mismatchFrom:cursor,mismatchTo:end,modelledUnit,reason});
    }
    cursor=end;
  };
  // Converting an elevation back to a depth can move an observed contact by a few ulps.
  const epsilon=4*Number.EPSILON*Math.max(1,Math.abs(collar),Math.abs(from),Math.abs(to));
  const clip=(depth:number)=>{
    if(depth<=from)return from;
    if(depth>=to)return to;
    const nearest=depth-from<to-depth?from:to;
    return Math.abs(depth-nearest)<=epsilon?nearest:depth;
  };
  for(const band of bands){
    const start=clip(band.from),end=clip(band.to);
    if(end<=cursor)continue;
    record(start,null);
    record(end,band.unit);
    if(cursor>=to)break;
  }
  record(to,null);
  return row;
}

export function auditCollarAgreement(model:GeoModel):CollarAgreementAudit{
  const hasSolids=!model.logOnlyReason&&model.triangles.length>0;
  const result:CollarAgreementAudit={status:hasSolids?"modelled":"logs-only",loggedMetres:0,matchedMetres:0,mismatchedMetres:0,unknownMetres:0,intervals:[],discrepancies:[]};
  // The synthetic CPT log contains only mapped layers. Retain original row numbers so a review addresses the
  // correct observation when there are unmapped layers in the input.
  const sourceKey=(c:Pick<Borehole,"id"|"x"|"y"|"z">)=>JSON.stringify([c.id,c.x,c.y,c.z]);
  const cptIndices=new Map<string,number[]>();
  if(model.cptLogs.length)for(const cpt of model.project.cpts??[]){
    const key=sourceKey(cpt);
    if(cptIndices.has(key))continue;
    const indices=cpt.layers?.flatMap((layer,i)=>layer.unit?[i]:[]);
    if(indices?.length)cptIndices.set(key,indices);
  }
  const collect=(log:Borehole,node:number,kind:LoggedInterval["kind"])=>{
    const sourceIndices=kind==="cpt"?cptIndices.get(sourceKey(log)):undefined;
    const bands=hasSolids?columnAt(model,node,log.z):[];
    log.intervals.forEach((interval,i)=>{
      const {from,to,unit}=interval;
      if(!unit||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from)return;
      const intervalIndex=kind==="cpt"?sourceIndices?.[i]??-1:i;
      const row=compareInterval({holeId:log.id,kind,intervalIndex,from,to,unit},bands,hasSolids,log.z);
      result.intervals.push(row);
      for(const gap of row.discrepancies)result.discrepancies.push(gap);
      result.loggedMetres+=row.loggedMetres;
      result.matchedMetres+=row.matchedMetres;
      result.mismatchedMetres+=row.mismatchedMetres;
      result.unknownMetres+=row.unknownMetres;
    });
  };
  model.boreholes.forEach((log,node)=>collect(log,node,"borehole"));
  model.cptLogs.forEach((log,i)=>collect(log,model.boreholes.length+i,"cpt"));
  return result;
}
