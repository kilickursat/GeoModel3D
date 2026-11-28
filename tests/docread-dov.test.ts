import {expect,it} from "vitest";
import {header,readPage,textLine} from "../src/docread/reconstruct";
import {unitFor} from "../src/docread/draft";
const line=(text:string,x:number,y:number)=>textLine(text,x,y,x+text.length*6,y+10);

it("keeps the printed DOV test number and its evidence",()=>{
  const value=line("GEO-74/026-B",150,20);
  const h=header([line("Proefnummer:",40,20),value]);
  expect(h.id).toBe(value.text);
  expect(h.src?.id).toBe(value);
});

it("excludes DOV interpretation-only pages even if their table has complete depth pairs",()=>{
  const lines=[line("DOV Boorrapport",400,20),line("Informele stratigrafie - 14/03/1974",40,70),
    line("Van(m)",40,90),line("Tot(m)",100,90),line("Beschrijving",175,90),
    line("0.00",40,120),line("1.20",100,120),line("Quartair",175,120),
    line("1.20",40,140),line("2.50",100,140),line("Tertiair",175,140)];
  const [interpretation]=readPage(lines,1000,800);
  expect(interpretation.layers).toHaveLength(0);
  expect(interpretation.evidence).toBe(false);
  // A report with a lithological section on the same page remains eligible for reading.
  expect(readPage([...lines,line("Lithologische beschrijving",40,55)],1000,800)[0].evidence).toBe(true);
});

it("leaves idem references for review even if they mention gravel or a transition to clay",()=>{
  expect(unitFor("idem, met gebroken schelpen")).toBe("");
  expect(unitFor("idem, met grind")).toBe("");
  expect(unitFor("idem, tot sterk zandhoudende klei")).toBe("");
});
