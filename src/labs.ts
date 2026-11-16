// Experimental tools stay hidden unless the page address asks for them, e.g. ?labs=core-ai (comma-separated for
// several). "core-ai" is the local vision-language description of core photographs: no model has passed a review by
// a geologist, and in the 0.25 pilot the SmolVLM model it offers gave no useful answer on 8 public core images.
export type Lab="core-ai";
export function labEnabled(lab:Lab,search:string=globalThis.location?.search??""):boolean{
  try{return (new URLSearchParams(search).get("labs")??"").split(",").map(v=>v.trim()).includes(lab)}catch{return false}
}
