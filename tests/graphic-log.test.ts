import {describe,it,expect} from "vitest";
import {readDocument,textLine} from "../src/docread/reconstruct";
import {unitFor} from "../src/docread/draft";

const line=(text:string,x:number,y:number,w=75)=>textLine(text,x,y,x+w,y+10);
const figure=()=>[
  line("The planned borehole was 90 m east of this site.",20,20,280),
  line("Depth (m)",10,50),line("0–2 m:",100,90),line("Silt",240,90),
  line("2–11.2 m:",100,145),line("Weathered conglomerate",240,140),line("with sandstone clasts at 5 m.",240,152),
  line("Figure 3.2: Graphic log of BH-04.",20,255,220)
];
const read=(lines:ReturnType<typeof figure>)=>readDocument([{page:13,width:700,height:800,lines}]).logs;
describe("captioned graphic logs",()=>{
  it("ties printed ranges and their descriptions to the named hole and original source boxes",()=>{
    const [log]=read(figure());
    expect(log).toMatchObject({id:"BH-04",pages:[13],rangeLabels:true,layers:[
      {from:0,to:2,description:"Silt"},{from:2,to:11.2,description:"Weathered conglomerate with sandstone clasts at 5 m."}
    ]});
    expect(log.src?.id).toMatchObject({text:"Figure 3.2: Graphic log of BH-04.",page:13});
    expect(log.layers[1].src.map(s=>[s.page,s.text])).toEqual([[13,"2–11.2 m:"],[13,"Weathered conglomerate"],[13,"with sandstone clasts at 5 m."]]);
  });
  it("leaves unlabeled, discontinuous or spatially ambiguous intervals for review",()=>{
    const lines=figure();
    expect(read(lines.slice(0,-1))).toHaveLength(0);
    expect(read(lines.map(l=>l.text==="2–11.2 m:"?{...l,text:"3–11.2 m:"}:l))).toHaveLength(0);
    expect(read([...lines,line("Loose sand",240,200)])).toHaveLength(0);
  });
  it("distinguishes a reference stratigraphy table from a measured table with the same columns",()=>{
    const rows=[line("From (m)",100,60,38),line("To (m)",165,60,38),line("Description",248,60,86),
      line("0.0",100,90,30),line("2.0",165,90,30),line("Silt",248,90),
      line("2.0",100,114,30),line("4.0",165,114,30),line("Gravel",248,114)];
    expect(read([line("Table D.6: Nearby well stratigraphy",40,30,275),...rows])).toHaveLength(0);
    expect(read([line("Table 3: Measured soil intervals",40,30,275),...rows])[0].layers.map(l=>l.to)).toEqual([2,4]);
  });
  it("keeps coarse clastic rock distinct from sandstone, including when sandstone is reported as clasts",()=>{
    expect(unitFor("Waihora Volcanics - polymict volcaniclastic conglomerate with boulders")).toBe("Conglomerate and breccia");
    expect(unitFor("Sandstone with conglomerate clasts")).toBe("Sandstone");
    expect(unitFor("volcanic breccia")).toBe("Rock");
  });
});
