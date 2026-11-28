// Generate original, editable test pages. Coordinates give each text baseline in points
// measured down from the top of a 1000 by 800 point page.
export interface PrintedLine { text:string; x:number; y:number; vertical?:boolean }
export const print=(text:string,x:number,y:number):PrintedLine=>({text,x,y});

export function makePdf(pages:PrintedLine[][]):Uint8Array {
  const objects:string[]=[];
  const add=(body:string)=>objects.push(body);
  const catalog=add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // Fill the page tree once all of its pages have object numbers.
  const latin=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const cid=add("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> >>");
  const japanese=add(`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UTF16-H /DescendantFonts [${cid} 0 R] >>`);
  const refs=pages.map(lines=>{
    const commands=lines.map(({text,x,y,vertical})=>{
      const ascii=/^[\x20-\x7e]+$/.test(text);
      // Japanese text uses the predefined Adobe CMap. All fixture characters lie in the BMP.
      const literal=ascii?`(${text.replace(/[()\\]/g,"\\$&")})`:`<${Array.from(text,c=>c.charCodeAt(0).toString(16).padStart(4,"0")).join("")}>`;
      return `BT /${ascii?"F1":"F2"} 12 Tf ${vertical?"0 1 -1 0":"1 0 0 1"} ${x} ${800-y} Tm ${literal} Tj ET`;
    }).join("\n");
    const contents=add(`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 800] /Resources << /Font << /F1 ${latin} 0 R /F2 ${japanese} 0 R >> >> /Contents ${contents} 0 R >>`);
  });
  objects[1]=`<< /Type /Pages /Count ${pages.length} /Kids [${refs.map(n=>n+" 0 R").join(" ")}] >>`;
  let pdf="%PDF-1.4\n";
  const offsets=objects.map((body,i)=>{
    const start=pdf.length;
    pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;
    return start.toString().padStart(10,"0")+" 00000 n \n";
  });
  const xref=pdf.length,count=objects.length+1;
  pdf+=`xref\n0 ${count}\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Size ${count} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export function stripSheet():PrintedLine[]{
  const at=(d:number)=>180+d*48;
  return [print("BOREHOLE LOG SYN-41",40,40),print("Ground level: 77.40 m",40,64),
    print("E: 430100, N: 5680100",420,64),print("Water level: 2.45 m",40,88),
    print("DESCRIPTION",300,135),...Array.from({length:12},(_,d)=>print(String(d),40,at(d))),
    ...[2.65,6.25,10.75].map(d=>print(d.toFixed(2),850,at(d)+8)),
    print("GRAVEL with smooth pebbles",300,at(1.3)),print("SILT with sand pockets",300,at(4)),
    print("CLAY with gypsum grains",300,at(8.4))];
}

export function stackedTables():PrintedLine[]{
  const holes=[
    {id:"SYN-81",ground:64.75,water:1.65,x:435210,y:5671200,bases:[1.85,4.35,7.25],descriptions:["Amber fine sand","Clay with chalk flecks","Gravel in pale sand"]},
    {id:"SYN-83",ground:66.82,water:2.35,x:435380,y:5671340,bases:[2.15,5.65,8.95],descriptions:["Silt with sandy seams","Loose sand with mica","Dense pale gravel"]},
  ];
  return holes.flatMap((hole,i)=>{
    const y=34+400*i;
    return [print("BOREHOLE LOG "+hole.id,50,y),print("Ground level: "+hole.ground+" m",50,y+26),
      print("E: "+hole.x+", N: "+hole.y,420,y+26),print("Water level: "+hole.water+" m",665,y+26),
      print("Final depth: "+hole.bases.at(-1)+" m",50,y+50),print("From",78,y+100),print("To",166,y+100),print("Description",330,y+100),
      ...hole.bases.flatMap((base,k)=>{
        const row=y+162+50*k;
        return [{...print((hole.bases[k-1]??0).toFixed(2),94,row+10),vertical:true},
          {...print(base.toFixed(2),180,row+10),vertical:true},print(hole.descriptions[k],330,row)];
      })];
  });
}
