import {makeReportPageExcerpt,reportQuestionPassages,type ReportQuestion} from "./reportQwenExcerpt";

/** Page roles are suggestions. The calling reader owns the page numbers, checkboxes and extracted values. */
export interface ReportPageIndex {page:number;lines:readonly string[]}
export type ReportQwenGoal="both"|ReportQuestion;
export type ReportQwenRequest={question:ReportQuestion;excerpt:string}[][];
export type ReportPageRole="log"|"schedule"|"both"|"other";
export interface ReportPageSuggestions {logs:number[];schedules:number[];unreadable:number[]}
export type ReportQwenResponse={progress:string}|{index:number;role:ReportPageRole}|{roles:ReportPageRole[]}|{error:string};
interface ReportPageExcerpt {page:number;text:string}
function isReportPageRole(value:unknown):value is ReportPageRole{
  return value==="log"||value==="schedule"||value==="both"||value==="other";
}

// Only bounded native text enters the worker. Source page numbers stay with the calling reader.
export function reportPageExcerpts(pages:readonly ReportPageIndex[]):ReportPageExcerpt[]{
  const numbers=new Set<number>();
  return pages.map(({page,lines})=>{
    if(!Number.isSafeInteger(page)||page<1||numbers.has(page))throw new Error("Each indexed page needs a distinct positive page number.");
    numbers.add(page);
    return {page,text:makeReportPageExcerpt(lines)};
  });
}

export function reportPageSuggestions(excerpts:readonly ReportPageExcerpt[],roles:readonly ReportPageRole[]):ReportPageSuggestions{
  const readable=excerpts.filter(e=>e.text);
  if(!Array.isArray(roles)||roles.length!==readable.length||roles.some(r=>!isReportPageRole(r)))
    throw new Error("Qwen returned an incomplete page classification.");
  const result:ReportPageSuggestions={logs:[],schedules:[],unreadable:excerpts.filter(e=>!e.text).map(e=>e.page)};
  readable.forEach(({page},i)=>{
    if(roles[i]==="log"||roles[i]==="both")result.logs.push(page);
    if(roles[i]==="schedule"||roles[i]==="both")result.schedules.push(page);
  });
  return result;
}

export async function suggestReportPages(pages:readonly ReportPageIndex[],{signal,onProgress,onPage,goal="both"}:{
  signal:AbortSignal;goal?:ReportQwenGoal;onProgress?:(message:string)=>void;onPage?:(page:number,role:ReportPageRole)=>void
}):Promise<ReportPageSuggestions>{
  signal.throwIfAborted();
  const excerpts=reportPageExcerpts(pages),readable=excerpts.filter(e=>e.text);
  if(!readable.length)return reportPageSuggestions(excerpts,[]);
  const questions:ReportQuestion[]=goal==="both"?["log","schedule"]:[goal];
  const request:ReportQwenRequest=readable.map(({text})=>{
    const passages=reportQuestionPassages(text.split("\n"));
    return questions.map(question=>({question,excerpt:passages[question]}));
  });
  const worker=new Worker(new URL("./reportQwen.worker.ts",import.meta.url),{type:"module"});
  let abort:()=>void=()=>{};
  try{
    const roles=await new Promise<ReportPageRole[]>((resolve,reject)=>{
      const classified:ReportPageRole[]=[];
      abort=()=>reject(new DOMException("Page suggestions cancelled.","AbortError"));
      signal.addEventListener("abort",abort,{once:true});
      worker.onerror=e=>reject(new Error(e.message||"The local Qwen worker stopped."));
      worker.onmessageerror=()=>reject(new Error("The local Qwen worker returned an unreadable message."));
      worker.onmessage=({data}:MessageEvent<ReportQwenResponse>)=>{
        if(signal.aborted)return;
        try{
          if("progress" in data)onProgress?.(data.progress);
          else if("error" in data)throw new Error(data.error);
          else if("index" in data){
            if(data.index!==classified.length||data.index>=readable.length||!isReportPageRole(data.role)||
              goal!=="both"&&data.role!=="other"&&data.role!==goal)
              throw new Error("Qwen returned an invalid page classification.");
            classified.push(data.role);
            onPage?.(readable[data.index].page,data.role);
          }else{
            if(classified.length!==readable.length||!Array.isArray(data.roles)||data.roles.length!==classified.length||
              data.roles.some((role,i)=>role!==classified[i]))throw new Error("Qwen returned an incomplete page classification.");
            resolve(classified);
          }
        }catch(error){worker.onmessage=null;reject(error)}
      };
      worker.postMessage(request);
    });
    return reportPageSuggestions(excerpts,roles);
  }finally{
    signal.removeEventListener("abort",abort);worker.onmessage=null;worker.terminate();
  }
}
