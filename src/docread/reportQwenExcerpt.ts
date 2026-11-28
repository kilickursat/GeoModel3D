import {nativeReportFieldRows} from "./nativeLogFields";
// Select literal page text for the two local evidence questions. Omission marks keep separated rows distinct.
const MAX_CHARS=960;
const MAX_LINE_CHARS=220;
const COORDINATE=/\b(?:easting|northing|latitude|longitude|[xy][- ]co[oö]rd(?:inate)?)\b/i;
const DEPTH_RANGE=/\b\d+(?:[.,]\d+)?\s*(?:[-–—]|to|tot)\s*\d+(?:[.,]\d+)?\s*(?:m\b|ft\b|feet\b|metres?\b|meters?\b|:)/i;
const MATERIAL=/\b(?:clay|sand|silt|gravel|peat|soil|fill|rock|sandstone|mudstone|siltstone|shale|granite|limestone|basalt|conglomerate|regolith|argile|zand|klei|leem)\b/i;
const QUALIFIER=/\b(?:planned|proposed|estimated|expected|actual|interpreted|neighbou?ring|adjacent|off[- ]site|as[- ]drilled|as[- ]built|surveyed)\b/i;
const HEADING=/\b(?:graphic log|borehole log|boring log|lithology|lithologic(?:al)? log|stratigraphy|hole id|from\s*\(?(?:m|ft)\)?\s+to|description of (?:soil|strata)|coordinates?|borehole locations?)\b/i;
const LOG_HEADING=/\b(?:graphic log|borehole log|boring log|litholog\w*|stratigraphy|description of (?:soil|strata)|from\b.*\bto)\b/i;
const SCHEDULE_HEADING=/\b(?:hole id|collar|coordinate|borehole location|well location)\b/i;
const NUMERIC_ROW=/^\s*(?:[-+]?\d+(?:[.,]\d+)?\s+){2}/;
const GRID_PAIR=/(?:^|\s)[+-]?\d{4,8}(?:\.\d+)?\s+[+-]?\d{4,8}(?:\.\d+)?(?:\s|$)/;
const DEGREE_PAIR=/(?:^|\s)[+-]?\d{1,3}\.\d{3,}°?[,\s]+[+-]?\d{1,3}\.\d{3,}°?(?:\s|$)/;

// PDF text sometimes arrives as one long line. Keep later field labels eligible during ranking.
function wrap(line:string):string[]{
  if(line.length<=MAX_LINE_CHARS)return [line];
  const chunks:string[]=[];
  while(line.length>MAX_LINE_CHARS){
    const space=line.lastIndexOf(" ",MAX_LINE_CHARS);
    const at=space>MAX_LINE_CHARS/2?space:MAX_LINE_CHARS;
    chunks.push(line.slice(0,at));line=line.slice(at).trimStart();
  }
  if(line)chunks.push(line);
  return chunks;
}

function render(lines:readonly string[],indices:ReadonlySet<number>):string{
  let previous=-1;
  return [...indices].sort((a,b)=>a-b).map(i=>{
    const gap=previous>=0&&i>previous+1?"…\n":"";
    previous=i;
    return gap+lines[i];
  }).join("\n");
}

export type ReportQuestion="log"|"schedule";
export type ReportQuestionPassages=Record<ReportQuestion,string>;

function pack(source:readonly string[],goal:ReportQuestion|"both",limit:number):string{
  const nativeLines=source.map(line=>line.trim()).filter(Boolean);
  if(!nativeLines.length)return "";
  const full=nativeLines.join("\n");
  if(goal==="both"&&full.length<=limit)return full;

  const lines=nativeLines.flatMap(wrap),scores=lines.map(()=>0);
  const score=(i:number,value:number)=>{
    if(i>=0&&i<scores.length&&lines[i]!=="…")scores[i]=Math.max(scores[i],value);
  };
  const fields=nativeReportFieldRows(lines);
  if(goal!=="log")for(const i of fields.location)score(i,13);
  if(goal!=="schedule")for(const i of fields.layers)score(i,12);
  let coordinateHeader=false,sampleRows=0;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(goal!=="log"){
      if(COORDINATE.test(line)){
        coordinateHeader=true;
        score(i,10);
        if(goal==="both"){score(i-1,5);score(i+1,8)}
        else if(/^[-+]?\d/.test(lines[i+1]??""))score(i+1,8);
      }
      // Wrapped table headers may precede the first values by many lines. Keep IDs with two representative records.
      if(coordinateHeader&&sampleRows<2&&(GRID_PAIR.test(line)||DEGREE_PAIR.test(line))){
        score(i,10);sampleRows++;
        for(let j=i-1;j>=Math.max(0,i-3)&&lines[j].length<=35;j--)score(j,8);
      }
      if(goal==="schedule"&&SCHEDULE_HEADING.test(line)&&line.length<120)score(i,7);
    }
    if(goal!=="schedule"){
      if(DEPTH_RANGE.test(line)||NUMERIC_ROW.test(line)&&MATERIAL.test(line)){
        score(i,9);
        if(goal==="both"){score(i-1,4);score(i+1,6)}
        else if(MATERIAL.test(lines[i+1]??""))score(i+1,7);
      }
      if(MATERIAL.test(line))score(i,/\b\d+[.,]?\d*\s*m\b/.test(line)?7:3);
      if(goal==="log"&&LOG_HEADING.test(line)&&line.length<150)score(i,10);
    }
    if(QUALIFIER.test(line)&&(line.length<=75||COORDINATE.test(line)||HEADING.test(line)))score(i,11);
    if(goal==="both"&&HEADING.test(line)&&line.length<150){score(i,8);score(i+1,4)}
  }
  // When no relevant cues were found the model still sees literal source samples to evaluate unfamiliar language or layouts.
  if(goal==="both"||!scores.some(score=>score>0)){
    score(0,6);
    for(const fraction of [0,1,0.5,0.25,0.75])score(Math.round((lines.length-1)*fraction),2);
  }
  const ranked=lines.map((_,i)=>i).filter(i=>scores[i]>0).sort((a,b)=>scores[b]-scores[a]||a-b);
  const kept=new Set<number>();
  for(const i of ranked){
    kept.add(i);
    if(render(lines,kept).length>limit)kept.delete(i);
  }
  return render(lines,kept);
}

export function makeReportPageExcerpt(lines:readonly string[]):string{
  return pack(lines,"both",MAX_CHARS);
}

/** These identical passages are inspected by the reviewer and submitted to the local worker. */
export function reportQuestionPassages(source:readonly string[]):ReportQuestionPassages{
  const lines=makeReportPageExcerpt(source).split("\n");
  return {log:pack(lines,"log",480),schedule:pack(lines,"schedule",480)};
}
