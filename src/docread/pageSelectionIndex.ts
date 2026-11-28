// These labels guide page selection only. A coordinate or bed still needs its own verified source.
import {judgeText} from "./textlines";
import {isDovInterpretationPage} from "./reconstruct";
import {makeReportPageExcerpt} from "./reportQwenExcerpt";
import type {ReportPageRole,ReportQwenGoal} from "./reportQwen";

const LOG_TITLE=/\b(?:log of (?:test )?(?:boring|borehole|drillhole|well)|(?:boring|borehole|drill(?:hole)?|well|core) (?:\/ ?drill )?log|boor(?:staat|profiel|beschrijving)|sondage géotechnique)\b|柱状図/i;
const STRATA_HEADING=/\b(?:litholog(?:y|ic(?:al)? (?:log|description))|(?:soil|strat(?:a|um)|material|rock) description|description of (?:strata|soil|material)|beschrijving|omschrijving)\b|土質区分|地層名/i;
const HOLES=/\b(?:boreholes?|borings?|drill[ -]?holes?|wells?|collars?|soundings?|peilbuizen|sondages?|boringen)\b|孔番|調査孔/i;
const SCHEDULE=/\b(?:borehole|boring|drill[ -]?hole|hole|well|test pit|collar|exploration|sampling point|investigation point) (?:locations?|coordinates?|inventory|schedule|summary|information|data)\b|\b(?:location|coordinate|collar) (?:schedule|table|summary)\b/i;
const PLANNED_LOCATION=/\b(?:planned|proposed|target)\s+(?:collar\s+)?(?:locations?|coordinates?|easting|northing|latitude|longitude)\b/i;
const XY=/\beasting\b|\blongitude\b|\bx[- ]co[oö]rd/i,YX=/\bnorthing\b|\blatitude\b|\by[- ]co[oö]rd/i;
const WATER=/\b(?:groundwater|ground water|piezometer|water[- ](?:table|level))\b|grondwater|地下水位/i;
const DATUM=/\b(?:vertical datum|survey datum|coordinate (?:reference )?system|horizontal datum|EPSG|NAVD ?88|NGVD ?29|Australian height datum|ordnance datum|ordnance survey national grid)\b|座標系/i;
const REPORT_HEADING=/^(?:(?:chapter\s+)?\d+(?:\.\d+)*\.?\s+)?(?:table of contents|contents|list of (?:figures|tables)|scope of (?:work|services)|executive summary|acknowledg(?:e)?ments|references(?: cited)?)\b/i;
const INDEX_HEADING=/^(?:table of contents|contents|list of (?:figures|tables))\s*$/i;
const NUMBER=/[-+]?\d+(?:[.,]\d+)?/g;
const labels={log:"Borehole log",schedule:"Location schedule",planned:"Includes planned locations",datum:"Coordinate or datum reference",water:"Groundwater information",
  interpreted:"Interpreted stratigraphy",report:"Report text",unknown:"Check page",scan:"Check scan"} as const;
export type PageRole=keyof typeof labels;
export interface IndexedReportPage {page:number;role:PageRole;lines:string[];excerpt:string}
export const pageRoleLabel=(role:PageRole)=>labels[role];

export function indexReportPage(page:number,sourceLines:readonly string[]):IndexedReportPage{
  const lines=sourceLines.map(l=>l.replace(/\s+/g," ").trim()).filter(Boolean);
  const raw=lines.join(" ");
  const layer=judgeText(lines,raw.replace(/\s/g,"").length,30).layer;
  if(layer==="none"||layer==="garbled")return {page,role:"scan",lines:[],excerpt:"Preview to identify this page."};
  const top=lines.slice(0,10);
  const tableData=(raw.match(NUMBER)?.length??0)>=4;
  const strata=lines.find(l=>STRATA_HEADING.test(l)&&l.length<=115);
  const logTitle=top.find(l=>LOG_TITLE.test(l)&&l.length<=95);
  const hasDepth=/\bdepth\b|\bfrom\b|\bvan\b|diepte|深度/i.test(raw);
  const schedule=lines.find(l=>SCHEDULE.test(l)&&l.length<=160);
  let role:PageRole="unknown",heading:string|undefined;
  if(top.some(l=>INDEX_HEADING.test(l))){
    role="report";heading=top.find(l=>INDEX_HEADING.test(l));
  }else if(isDovInterpretationPage(lines)){
    role="interpreted";heading=lines.find(l=>/stratigrafie/i.test(l));
  }else if(tableData&&(logTitle&&hasDepth||strata&&hasDepth&&(/\bto\b|\btot\b|層厚/i.test(raw)||!!logTitle))){
    role="log";heading=logTitle??strata;
  }else if(tableData&&(schedule||XY.test(raw)&&YX.test(raw)&&HOLES.test(raw))){
    const planned=lines.find(l=>PLANNED_LOCATION.test(l));
    role=planned?"planned":"schedule";heading=planned??schedule??lines.find(l=>XY.test(l));
  }else if(DATUM.test(raw)){
    role="datum";heading=lines.find(l=>DATUM.test(l));
  }else if(WATER.test(raw)){
    role="water";heading=lines.find(l=>WATER.test(l));
  }else if(top.some(l=>REPORT_HEADING.test(l))||lines.filter(l=>l.split(" ").length>=8).length>=5){
    role="report";heading=top.find(l=>REPORT_HEADING.test(l));
  }
  if(layer==="doubtful")role="unknown";
  // Budget model input once, from the native lines in source order. Labels, units and nearby values
  // belong in the same window; sampling isolated lines can turn a coordinate pair into a single number.
  return {page,role,lines:makeReportPageExcerpt(lines).split("\n").filter(Boolean),excerpt:(heading??lines.slice(0,4).join(" ")).slice(0,170)};
}

export function needsPageSelection(pages:readonly IndexedReportPage[]){
  return pages.length>1&&!pages.every(p=>p.role==="log");
}
export function initialPageSelection(pages:readonly IndexedReportPage[]):Set<number>{
  // Ambiguous pages and unreadable scans can be continuations. Keep them in the initial selection.
  return new Set(pages.filter(p=>p.role!=="report"&&p.role!=="interpreted").map(p=>p.page));
}

// An unanswered question stays undefined. A scoped rerun replaces only the answer it revisited.
export type PageAssessment=Partial<Record<"log"|"schedule",boolean>>;
export function recordPageAssessment(previous:PageAssessment|undefined,goal:ReportQwenGoal,role:ReportPageRole):PageAssessment{
  const result={...previous};
  if(goal!=="schedule")result.log=role==="log"||role==="both";
  if(goal!=="log")result.schedule=role==="schedule"||role==="both";
  return result;
}
