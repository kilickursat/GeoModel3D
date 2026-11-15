// The same crop plan drives the browser preview and reproducible image benchmarks.
import {corePieceBox} from "./corePhoto";
import type {CoreBox,CoreRow} from "./corePhoto";
import {CORE_AI_MAX_IMAGE_EDGE} from "./coreAi";

export interface CoreAiRegion {
  kind:"row"|"piece";rowId:string;pieceId?:string;from:number;to:number;direction:"ltr"|"rtl";box:CoreBox;
}
export interface CoreAiCropPlan {
  sourceWidth:number;sourceHeight:number;pixels:{x:number;y:number;width:number;height:number};width:number;height:number;
  preprocessing:{method:"aspect-preserving-gray-letterbox";scaledWidth:number;scaledHeight:number;scale:number;upscaled:boolean;
    padding:{left:number;top:number;right:number;bottom:number};background:string};
}
function validBox(box:CoreBox){
  if(!box||![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)||box.x0<0||box.y0<0||box.x1>1||box.y1>1||box.x1<=box.x0||box.y1<=box.y0)
    throw new Error("Register a valid photo region before describing an interval.");
}

/** An independent selection snapshot. Image direction changes the crop, never the recorded depths. */
export function selectCoreAiRegion(row:CoreRow,pieceId?:string):CoreAiRegion{
  if(!row||typeof row.id!=="string"||!row.id.trim()||![row.from,row.to].every(Number.isFinite)||row.from<0||row.to<=row.from||!["ltr","rtl"].includes(row.direction))
    throw new Error("The selected photo row has invalid depth registration.");
  validBox(row.box);
  if(pieceId===undefined)return {kind:"row",rowId:row.id,from:row.from,to:row.to,direction:row.direction,box:{...row.box}};
  if(typeof pieceId!=="string"||!pieceId.trim()||!Array.isArray(row.pieces))throw new Error("Choose a piece from the selected photo row.");
  let from=row.from,selected:CoreAiRegion|undefined;
  const ids=new Set<string>();
  for(const piece of row.pieces){
    if(!piece||typeof piece.id!=="string"||!piece.id.trim()||ids.has(piece.id)||!Number.isFinite(piece.end)||piece.end<=from||piece.end>row.to+1e-9)
      throw new Error("The selected row has inconsistent piece depths or identifiers.");
    ids.add(piece.id);
    if(piece.id===pieceId){
      const mapped=corePieceBox(row,from,piece.end);
      // The core schema tolerates sub-nanometre subtraction error at the final depth. Keep the crop inside its row.
      const box={x0:Math.max(row.box.x0,mapped.x0),x1:Math.min(row.box.x1,mapped.x1),y0:row.box.y0,y1:row.box.y1};
      validBox(box);selected={kind:"piece",rowId:row.id,pieceId,from,to:piece.end,direction:row.direction,box};
    }
    from=piece.end;
  }
  if(Math.abs(from-row.to)>1e-9)throw new Error("The selected row's pieces do not cover its registered depth interval.");
  if(!selected)throw new Error("That piece is no longer in the selected photo row.");
  return selected;
}

/** Cover the registered region with whole source pixels, then fit it to one square without stretching. */
export function coreAiCropPlan(region:Pick<CoreAiRegion,"box">,sourceWidth:number,sourceHeight:number,edge=CORE_AI_MAX_IMAGE_EDGE):CoreAiCropPlan{
  validBox(region?.box);
  if(![sourceWidth,sourceHeight].every(v=>Number.isSafeInteger(v)&&v>0)||!Number.isSafeInteger(sourceWidth*sourceHeight))
    throw new Error("The source photograph has invalid pixel dimensions.");
  if(!Number.isSafeInteger(edge)||edge<1||edge>4096)throw new Error("The analysis frame size must be between 1 and 4096 pixels.");
  const box=region.box,x=Math.min(sourceWidth-1,Math.max(0,Math.floor(box.x0*sourceWidth))),y=Math.min(sourceHeight-1,Math.max(0,Math.floor(box.y0*sourceHeight)));
  const right=Math.max(x+1,Math.min(sourceWidth,Math.ceil(box.x1*sourceWidth))),bottom=Math.max(y+1,Math.min(sourceHeight,Math.ceil(box.y1*sourceHeight)));
  const pixels={x,y,width:right-x,height:bottom-y},scale=edge/Math.max(pixels.width,pixels.height);
  const scaledWidth=Math.max(1,Math.round(pixels.width*scale)),scaledHeight=Math.max(1,Math.round(pixels.height*scale));
  const left=Math.floor((edge-scaledWidth)/2),top=Math.floor((edge-scaledHeight)/2);
  return {sourceWidth,sourceHeight,pixels,width:edge,height:edge,preprocessing:{method:"aspect-preserving-gray-letterbox",scaledWidth,scaledHeight,scale,
    upscaled:scale>1,padding:{left,top,right:edge-scaledWidth-left,bottom:edge-scaledHeight-top},background:"#808080"}};
}
