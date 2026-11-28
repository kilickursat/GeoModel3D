export function parseCsv(text:string,delimiter?:string,strict=false):string[][]{
  text=text.replace(/^﻿/,"");
  const d=delimiter??sniffDelimiter(text);
  const rows:string[][]=[];
  let row:string[]=[],field="",quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){
      if(ch==='"'&&text[i+1]==='"'){field+='"';i++}
      else if(ch==='"'){quoted=false;closed=true}
      else field+=ch;
    }else if(ch==='"'){
      if(strict&&(field.length||closed))throw new Error("Unexpected quote in CSV field.");
      quoted=true;
    }else if(ch===d){row.push(field);field="";closed=false}
    else if(ch==="\n"||ch==="\r"){
      if(ch==="\r"&&text[i+1]==="\n")i++;
      row.push(field);field="";
      if(row.some(f=>f.trim()!==""))rows.push(row);
      row=[];closed=false;
    }else{
      if(strict&&closed)throw new Error("Unexpected text after a quoted CSV field.");
      field+=ch;
    }
  }
  if(strict&&quoted)throw new Error("Unclosed quoted CSV field.");
  row.push(field);
  if(row.some(f=>f.trim()!==""))rows.push(row);
  return rows;
}
function sniffDelimiter(text:string){
  const line=text.split(/\r?\n/).find(l=>l.trim())??"";
  const count=(c:string)=>line.split('"').filter((_,i)=>i%2===0).join("").split(c).length-1;
  return [",",";","\t"].reduce((best,c)=>count(c)>count(best)?c:best,",");
}
function csvField(v:string|number|undefined){
  const s=v===undefined||Number.isNaN(v)?"":String(v);
  return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}
export function toCsv(rows:Array<Array<string|number|undefined>>){return rows.map(r=>r.map(csvField).join(",")).join("\n")+"\n"}
