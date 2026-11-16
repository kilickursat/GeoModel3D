// Saved projects and workspaces carry the images their evidence keeps: preview images of PDF and scanned pages, and
// core photographs. Before such a file is exported, say so, and offer to leave out the page previews. Core photographs
// stay: accepted photo logs and their review records depend on them. Source names and the text read from the pages
// remain in the file either way, and the dialog says that too.
import type {GeoProject} from "./schema";
import type {EditorTables} from "./tables";
import type {EvidenceCollection} from "./evidence";
import type {WorkspaceDocument,WorkspaceDraft} from "./workspace";

export interface ExportImages { pages:number;photos:number }
type Holder={evidence?:EvidenceCollection;corePhotos?:{runs:{sourceId:string}[]}};
export type ImageChoice="include"|"without-pages"|"cancel";

const photoSources=(holder:Holder)=>new Set(holder.corePhotos?.runs.map(r=>r.sourceId)??[]);
function collect(holder:Holder|undefined,pages:Set<string>,photos:Set<string>){
  if(!holder?.evidence)return;
  const ofPhotos=photoSources(holder);
  for(const source of holder.evidence.sources)for(const page of source.pages)if(page.image)(ofPhotos.has(source.id)?photos:pages).add(page.image);
}
function drafts(doc:WorkspaceDocument):WorkspaceDraft[]{
  return [doc.draft,...doc.scenarios.flatMap(s=>s.draft?[s.draft]:[])];
}
/** Distinct images: a page preview shared by several revisions counts once, as the file stores it once. */
export function exportImages(value:GeoProject|WorkspaceDocument):ExportImages{
  const pages=new Set<string>(),photos=new Set<string>();
  if("format" in value&&value.format==="geomodel3d-workspace"){
    for(const draft of drafts(value)){collect(draft.tables as Holder,pages,photos);collect(draft.base,pages,photos)}
    for(const revision of value.revisions)collect(revision.project,pages,photos);
  }else collect(value as GeoProject,pages,photos);
  return {pages:pages.size,photos:photos.size};
}

function withoutPages<T extends Holder>(holder:T):T{
  if(!holder.evidence)return holder;
  const ofPhotos=photoSources(holder);
  if(!holder.evidence.sources.some(s=>!ofPhotos.has(s.id)&&s.pages.some(p=>p.image)))return holder;
  return {...holder,evidence:{...holder.evidence,sources:holder.evidence.sources.map(s=>ofPhotos.has(s.id)?s:
    {...s,pages:s.pages.map(({image:_,...page})=>page)})}};
}
/** A copy without page previews; core photographs, source text, boxes and review history are kept. */
export function projectWithoutPagePreviews(project:GeoProject):GeoProject{return withoutPages(project)}
export function tablesWithoutPagePreviews(tables:EditorTables):EditorTables{return withoutPages(tables)}
export function workspaceWithoutPagePreviews(doc:WorkspaceDocument):WorkspaceDocument{
  const draft=(d:WorkspaceDraft):WorkspaceDraft=>({tables:tablesWithoutPagePreviews(d.tables),...(d.base?{base:withoutPages(d.base)}:{})});
  return {...doc,draft:draft(doc.draft),revisions:doc.revisions.map(r=>({...r,project:withoutPages(r.project)})),
    scenarios:doc.scenarios.map(s=>s.draft?{...s,draft:draft(s.draft)}:s)};
}

const plural=(n:number,one:string,many:string)=>`${n} ${n===1?one:many}`;
/** Asks only when the file would contain images. Escape and Cancel export nothing. */
export function chooseImageExport(images:ExportImages,what:string):Promise<ImageChoice>{
  if(!images.pages&&!images.photos)return Promise.resolve("include");
  return new Promise(resolve=>{
    const d=document.createElement("dialog");
    d.className="agree export-images";
    d.setAttribute("aria-labelledby","export-images-title");
    const parts=[images.pages?plural(images.pages,"page image from your PDFs or scans","page images from your PDFs or scans"):"",
      images.photos?plural(images.photos,"core photograph","core photographs"):""].filter(Boolean).join(" and ");
    d.innerHTML=`<h2 id="export-images-title">This ${what} includes images</h2>
<p>It contains ${parts}. Anyone you share the file with can see them. Source file names and the text read from them are included either way.</p>
${images.photos?`<p>Core photographs always stay in the file: the photo logs and their review records depend on them.</p>`:""}
<div class="agree-actions"><button value="cancel">Cancel</button>${images.pages?'<button value="without-pages">Leave out page images</button>':""}<button value="include" class="agree-yes">Include ${images.pages?"images":"photographs"}</button></div>`;
    const done=(choice:ImageChoice)=>{d.close();d.remove();resolve(choice)};
    d.addEventListener("cancel",e=>{e.preventDefault();done("cancel")});
    d.addEventListener("click",e=>{const b=(e.target as Element).closest("button");if(b)done(b.value as ImageChoice)});
    document.body.appendChild(d);
    d.showModal();
  });
}
