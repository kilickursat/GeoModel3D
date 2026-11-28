import {afterEach,describe,expect,it,vi} from "vitest";
import {reportPageExcerpts,reportPageSuggestions,suggestReportPages} from "../src/docread/reportQwen";
import {reportQuestionPassages} from "../src/docread/reportQwenExcerpt";
import type {ReportQwenResponse} from "../src/docread/reportQwen";

const pages=[{page:3,lines:["Survey schedule"]},{page:8,lines:[" "]},{page:10,lines:["Logged depths"]}];

describe("local Qwen page suggestions",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("keeps physical PDF page numbers and reports pages without indexable text",()=>{
    expect(reportPageSuggestions(reportPageExcerpts(pages),["schedule","both"])).toEqual({
      logs:[10],schedules:[3,10],unreadable:[8]
    });
    expect(()=>reportPageExcerpts([...pages,pages[0]])).toThrow(/distinct/);
    expect(()=>reportPageSuggestions(reportPageExcerpts(pages),["log"])).toThrow(/incomplete/);
  });
  it("bounds each excerpt, includes text down the page, and keeps every indexed page",()=>{
    const input=Array.from({length:60},(_,i)=>({page:i+1,lines:["Header","x".repeat(9000),"Final row"]}));
    const excerpts=reportPageExcerpts(input);
    expect(excerpts.map(e=>e.page)).toEqual(input.map(e=>e.page));
    expect(excerpts.every(e=>e.text.startsWith("Header")&&e.text.endsWith("Final row")&&e.text.length<1000)).toBe(true);
  });
  it("keeps qualified coordinate pairs and lithology depth rows in source order when a page is long",()=>{
    const narrative="This section outlines the administrative arrangements for the investigation and its supporting documentation.";
    const coordinates=["Planned collar locations","Hole ID EX-42","Longitude (GDA94) 146.123","Latitude (GDA94) -25.345",
      "Easting (MGA) 514869","Northing (MGA) 6894207"];
    const geology=["Graphic log EX-42","0-2 m:","2-7 m:","Loose silt","Weathered mudstone"];
    const input=["Borehole completion",...Array(40).fill(narrative),...coordinates,...Array(40).fill(narrative),...geology];
    const [{text}]=reportPageExcerpts([{page:17,lines:input}]);
    expect(text).toContain(coordinates.join("\n"));
    expect(text).toContain(geology.join("\n"));
    expect(text).toContain("\n…\n");
    expect(text.indexOf("Northing")).toBeLessThan(text.indexOf("Graphic log"));
    expect(reportPageExcerpts([{page:17,lines:text.split("\n")}])[0].text).toBe(text);
  });
  it("retains ID and coordinate records under a wrapped schedule header",()=>{
    const record=["5510-112","(B3)","20019 Sept-17 11.0 462711 6187561 Formation"];
    const lines=["Well schedule","Easting Northing","Screen","length","m","Unit","Status",
      ...record,...Array(50).fill("Other information continues in a related part of the report.")];
    const [{text}]=reportPageExcerpts([{page:4,lines}]);
    expect(text).toContain("Easting Northing");expect(text).toContain(record.join("\n"));
  });
  it("finds coordinate fields late in a single long text run",()=>{
    const line="Site administration and reporting. ".repeat(100)+"Latitude -24.5642 Longitude 135.5613";
    expect(reportPageExcerpts([{page:21,lines:[line]}])[0].text).toContain("Latitude -24.5642 Longitude 135.5613");
  });
  it("skips starting a model when the pages have no native text",async()=>{
    const worker=vi.fn();vi.stubGlobal("Worker",worker);
    await expect(suggestReportPages([pages[1]],{signal:new AbortController().signal})).resolves.toEqual({logs:[],schedules:[],unreadable:[8]});
    expect(worker).not.toHaveBeenCalled();
  });
  it("passes only the excerpts to the worker and unloads on cancellation",async()=>{
    const post=vi.fn(),terminate=vi.fn();
    vi.stubGlobal("Worker",class {postMessage=post;terminate=terminate});
    const controller=new AbortController();
    const running=suggestReportPages(pages,{signal:controller.signal});
    expect(post).toHaveBeenCalledWith([
      [{question:"log",excerpt:"Survey schedule"},{question:"schedule",excerpt:"Survey schedule"}],
      [{question:"log",excerpt:"Logged depths"},{question:"schedule",excerpt:"Logged depths"}]
    ]);
    controller.abort();await expect(running).rejects.toMatchObject({name:"AbortError"});
    expect(terminate).toHaveBeenCalledOnce();
  });
  it("only submits the requested evidence question and its literal inspectable passage",async()=>{
    const post=vi.fn();
    vi.stubGlobal("Worker",class {postMessage=post;terminate=vi.fn()});
    const lines=["Borehole BH-1","Easting 342766","Northing 6882567","0-2 m: sandy clay","2-6 m: gravel"];
    const passages=reportQuestionPassages(lines);
    expect(passages.schedule).toContain("Northing 6882567");expect(passages.schedule).not.toContain("gravel");
    expect(passages.log).toContain("2-6 m: gravel");expect(passages.log).not.toContain("Easting");
    for(const goal of ["schedule","log"] as const){
      const controller=new AbortController();
      const running=suggestReportPages([{page:9,lines}],{signal:controller.signal,goal});
      expect(post).toHaveBeenLastCalledWith([[{question:goal,excerpt:passages[goal]}]]);
      controller.abort();await expect(running).rejects.toMatchObject({name:"AbortError"});
    }
  });
  it("reports completed physical pages, including other, and confirms the final suggestions",async()=>{
    const onPage=vi.fn();
    vi.stubGlobal("Worker",class {
      terminate=vi.fn();
      onmessage?:(event:{data:ReportQwenResponse})=>void;
      postMessage(){
        this.onmessage?.({data:{index:0,role:"schedule"}});
        this.onmessage?.({data:{index:1,role:"other"}});
        this.onmessage?.({data:{roles:["schedule","other"]}});
      }
    });
    await expect(suggestReportPages(pages,{signal:new AbortController().signal,onPage})).resolves.toEqual({logs:[],schedules:[3],unreadable:[8]});
    expect(onPage.mock.calls).toEqual([[3,"schedule"],[10,"other"]]);
  });
  it("retains completed suggestions on stop and ignores late results from the stopped run",async()=>{
    const controller=new AbortController(),onPage=vi.fn(()=>controller.abort());
    vi.stubGlobal("Worker",class {
      terminate=vi.fn();
      onmessage?:(event:{data:ReportQwenResponse})=>void;
      postMessage(){
        this.onmessage?.({data:{index:0,role:"log"}});
        this.onmessage?.({data:{index:1,role:"schedule"}});
      }
    });
    await expect(suggestReportPages(pages,{signal:controller.signal,onPage})).rejects.toMatchObject({name:"AbortError"});
    expect(onPage.mock.calls).toEqual([[3,"log"]]);
  });
  it("rejects out-of-order results before they can label a physical page",async()=>{
    const onPage=vi.fn();
    vi.stubGlobal("Worker",class {
      terminate=vi.fn();
      onmessage?:(event:{data:ReportQwenResponse})=>void;
      postMessage(){
        this.onmessage?.({data:{index:1,role:"log"}});
        this.onmessage?.({data:{index:0,role:"log"}});
      }
    });
    await expect(suggestReportPages(pages,{signal:new AbortController().signal,onPage})).rejects.toThrow(/invalid page/);
    expect(onPage).not.toHaveBeenCalled();
  });
  it("discards a partial model result and unloads instead of assigning a proposal to the wrong page",async()=>{
    const terminate=vi.fn();
    vi.stubGlobal("Worker",class {
      terminate=terminate;
      onmessage?:(event:{data:ReportQwenResponse})=>void;
      postMessage(){this.onmessage?.({data:{roles:["schedule"]}})}
    });
    await expect(suggestReportPages(pages,{signal:new AbortController().signal})).rejects.toThrow(/incomplete/);
    expect(terminate).toHaveBeenCalledOnce();
  });
});
