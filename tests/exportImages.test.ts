import {describe,it,expect} from "vitest";
import {exportImages,projectWithoutPagePreviews,workspaceWithoutPagePreviews} from "../src/exportImages";
import {checkpoint,createWorkspace,parseWorkspace,toWorkspaceJson} from "../src/workspace";
import {tablesFromProject} from "../src/tables";
import type {GeoProject} from "../src/schema";

const png=(n:number)=>"data:image/png;base64,"+btoa(String.fromCharCode(137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,n));
// A PDF source with two page previews, and a core photograph source that a core-photo run refers to.
function project():GeoProject{
  return {name:"Images",units:[{id:"sand",name:"Sand",color:"#db8"}],
    boreholes:[{id:"BH1",x:0,y:0,z:10,intervals:[{from:0,to:5,unit:"sand"}]}],
    evidence:{version:1,sources:[
      {id:"report",name:"report.pdf",pages:[{page:1,width:10,height:10,image:png(1)},{page:2,width:10,height:10,image:png(2)}]},
      {id:"photo",name:"core-box.jpg",pages:[{page:1,width:10,height:10,image:png(3)}]}],records:[]},
    corePhotos:{version:1,runs:[{sourceId:"photo"}]} as unknown as GeoProject["corePhotos"]};
}

describe("images in exported files",()=>{
  it("counts page previews apart from core photographs",()=>{
    expect(exportImages(project())).toEqual({pages:2,photos:1});
    expect(exportImages({name:"Plain",units:[],boreholes:[]})).toEqual({pages:0,photos:0});
  });

  it("leaves out page previews but keeps core photographs, text and page sizes",()=>{
    const p=project(),before=structuredClone(p),stripped=projectWithoutPagePreviews(p);
    expect(exportImages(stripped)).toEqual({pages:0,photos:1});
    expect(stripped.evidence!.sources[0].pages).toEqual([{page:1,width:10,height:10},{page:2,width:10,height:10}]);
    expect(stripped.evidence!.sources[1]).toBe(p.evidence!.sources[1]);
    expect(p).toEqual(before);
    const plain:GeoProject={name:"Plain",units:[],boreholes:[]};
    expect(projectWithoutPagePreviews(plain)).toBe(plain);
  });

  it("counts a workspace's distinct images once and strips every scope",()=>{
    const p=project(),plain={...p,corePhotos:undefined};delete plain.corePhotos;
    const doc=checkpoint(createWorkspace(tablesFromProject(plain),plain),plain,"Build");
    expect(exportImages(doc)).toEqual({pages:3,photos:0});
    const stripped=workspaceWithoutPagePreviews(doc);
    expect(exportImages(stripped)).toEqual({pages:0,photos:0});
    expect(exportImages(doc)).toEqual({pages:3,photos:0});
    const json=toWorkspaceJson(stripped);
    expect(json).not.toContain("data:image/png");
    expect(parseWorkspace(JSON.parse(json)).revisions[0].project.evidence!.records).toEqual([]);
  });
});
