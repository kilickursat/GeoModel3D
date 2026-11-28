// Shared by the app and benchmark so both decide how to read a PDF page from the same evidence.
import type {OPS,PDFPageProxy} from "pdfjs-dist";
import {linesFromItems,textChars,judgeText,type PdfTextItem,type TextLayer} from "./textlines";
import {logEvidence,type TextLine} from "./reconstruct";
import {pdfRules,type Rule} from "./ruling";

// Page coordinates use pixels at 150 dpi, the default raster resolution for OCR.
export const READ_SCALE=150/72;
const MIN_CHARS=30;
export interface PageText { page:number; width:number; height:number; lines:TextLine[]; scanned:boolean; layer?:TextLayer|"hidden"; share?:number; rules?:Rule[] }

// Some scanned reports carry a publisher's invisible OCR text that omits vertical headings.
// A page with visible text must keep its own text boxes, even if another part has invisible text.
function hiddenTextOverImage(ops:Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>,O:typeof OPS){
  let mode=0,hidden=false,image=false;
  const stack:number[]=[];
  for(let i=0;i<ops.fnArray.length;i++){
    switch(ops.fnArray[i]){
      case O.save: case O.paintFormXObjectBegin: stack.push(mode);break;
      case O.restore: case O.paintFormXObjectEnd: mode=stack.pop()??mode;break;
      case O.setTextRenderingMode: mode=ops.argsArray[i][0];break;
      case O.showText: case O.showSpacedText: case O.nextLineShowText: case O.nextLineSetSpacingShowText:
        if(mode!==3)return false;
        hidden=true;break;
      case O.paintImageXObject: case O.paintInlineImageXObject: case O.paintImageMaskXObject:
      case O.paintImageXObjectRepeat: case O.paintInlineImageXObjectGroup: case O.paintImageMaskXObjectRepeat: case O.paintImageMaskXObjectGroup:
        image=true;break;
    }
  }
  return hidden&&image;
}

export async function extractPageText(page:PDFPageProxy,O:typeof OPS):Promise<PageText>{
  try{
    const view=page.getViewport({scale:READ_SCALE});
    const items=(await page.getTextContent()).items as PdfTextItem[];
    const judged=judgeText(items.map(i=>i.str??""),textChars(items),MIN_CHARS);
    let layer:PageText["layer"]=judged.layer,lines=linesFromItems(items,view.transform),rules:Rule[]|undefined;
    if(layer!=="none"&&layer!=="garbled"){
      // A malformed graphic can fail to decode even though the page supplied readable text.
      const ops=await page.getOperatorList().catch(()=>undefined);
      if(ops&&hiddenTextOverImage(ops,O))layer="hidden";
      else if(ops&&logEvidence(lines)){
        rules=pdfRules(ops.fnArray,ops.argsArray,O,view.transform);
        if(rules.length)lines=linesFromItems(items,view.transform,rules);
      }
    }
    return {page:page.pageNumber,width:view.width,height:view.height,lines,scanned:layer==="none"||layer==="hidden",layer,share:judged.share,...(rules?.length?{rules}:{})};
  }finally{page.cleanup()}
}

// Pages that need OCR even when some words are present. A doubtful page is compared separately.
export function scanReason(t:PageText){
  if(t.layer==="none")return "a scanned page";
  if(t.layer==="hidden")return "a scan whose text is another program's OCR";
  if(t.layer==="garbled")return `unusable PDF text (${Math.round(100*(t.share??0))} % of it reads as words)`;
}
