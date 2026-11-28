import {auditCollarAgreement} from "./correlation";
import {correlationAcceptanceLookup} from "./correlationDecisions";
import type {GeoModel} from "./model";

export function readCollarReview(model:GeoModel){
  const audit=auditCollarAgreement(model);
  const acceptanceFor=correlationAcceptanceLookup(model);
  const rows=audit.status==="logs-only"?[]:audit.intervals.filter(i=>i.discrepancies.length)
    .map(interval=>({interval,acceptance:acceptanceFor(interval)}));
  const accepted=rows.filter(r=>r.acceptance).length;
  return {audit,rows,accepted,pending:rows.length-accepted};
}

export function collarReviewLabel(review:ReturnType<typeof readCollarReview>){
  const {pending,accepted}=review;
  const intervals=(n:number)=>`${n} logged interval${n===1?"":"s"}`;
  if(pending)return `Provisional volumes · ${intervals(pending)} pending collar review`;
  if(accepted)return `Collar differences accepted with reasons for ${intervals(accepted)}`;
  return "";
}
