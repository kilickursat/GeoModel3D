// A small non-validating XML reader for data files: elements, attributes, text, CDATA and character references.
// Declarations, doctypes (with internal subsets), comments and processing instructions are skipped.
export interface XmlNode { tag:string; attrs:Record<string,string>; children:XmlNode[]; text:string }

const ENTITIES:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
const decode=(s:string)=>s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e:string)=>
  e[0]==="#"?String.fromCodePoint(e[1]==="x"||e[1]==="X"?parseInt(e.slice(2),16):parseInt(e.slice(1),10)):ENTITIES[e]??m);

export function parseXml(src:string):XmlNode{
  const doc:XmlNode={tag:"#document",attrs:{},children:[],text:""};
  const stack=[doc];
  const top=()=>stack[stack.length-1];
  let i=0;
  while(i<src.length){
    const lt=src.indexOf("<",i);
    if(lt<0){top().text+=decode(src.slice(i));break}
    if(lt>i)top().text+=decode(src.slice(i,lt));
    if(src.startsWith("<!--",lt)){const e=src.indexOf("-->",lt+4);i=e<0?src.length:e+3;continue}
    if(src.startsWith("<![CDATA[",lt)){const e=src.indexOf("]]>",lt+9);top().text+=src.slice(lt+9,e<0?src.length:e);i=e<0?src.length:e+3;continue}
    if(src.startsWith("<?",lt)){const e=src.indexOf("?>",lt+2);i=e<0?src.length:e+2;continue}
    if(src.startsWith("<!",lt)){
      let j=lt+2,depth=0;
      for(;j<src.length;j++){const c=src[j];if(c==="[")depth++;else if(c==="]")depth--;else if(c===">"&&depth<=0)break}
      i=j+1;continue;
    }
    // The end of the tag, skipping ">" inside quoted attribute values.
    let j=lt+1,quote="";
    for(;j<src.length;j++){const c=src[j];if(quote){if(c===quote)quote=""}else if(c==='"'||c==="'")quote=c;else if(c===">")break}
    const body=src.slice(lt+1,j);
    i=j+1;
    if(body.startsWith("/")){
      const tag=body.slice(1).trim();
      const k=stack.map(n=>n.tag).lastIndexOf(tag);
      if(k>0)stack.length=k;
      continue;
    }
    const selfClosing=body.endsWith("/");
    const inner=selfClosing?body.slice(0,-1):body;
    const name=inner.match(/^[^\s/>]+/)?.[0]??"";
    const node:XmlNode={tag:name,attrs:{},children:[],text:""};
    for(const m of inner.slice(name.length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))node.attrs[m[1]]=decode(m[2]??m[3]??"");
    top().children.push(node);
    if(!selfClosing)stack.push(node);
  }
  return doc;
}

export const childNodes=(n:XmlNode,tag:string)=>n.children.filter(c=>c.tag===tag);
// Every element with this tag below n, in document order.
export function descendants(n:XmlNode,tag:string,out:XmlNode[]=[]):XmlNode[]{
  for(const c of n.children){if(c.tag===tag)out.push(c);descendants(c,tag,out)}
  return out;
}
// Trimmed text of the first element with this tag below n (depth first) that has any, or "".
export function textOf(n:XmlNode,tag:string):string{
  for(const c of n.children){
    const t=c.tag===tag?c.text.trim():textOf(c,tag);
    if(t)return t;
  }
  return "";
}
