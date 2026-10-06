import valleyDemo from "./data/valley-demo.json";
import channelDemo from "./data/channel-demo.json";
import {TerrainGrid} from "./terrain";

// Geological units are listed in stratigraphic order, youngest (top) to oldest (bottom). An erosive unit's base
// is an unconformity that cuts down into older units. Unit weights are in kN/m³; `source` records where the
// properties come from.
export interface UnitDef { id:string; name:string; color:string; erosive?:boolean; gamma?:number; gammaSat?:number; source?:string }
// Depths are metres below the collar; `unit` refers to UnitDef.id.
export interface Interval { from:number; to:number; unit:string }
// Collar position (x, y) and elevation (z) in the project coordinate system; `depth` is the final depth when it exceeds the logged intervals.
export interface Borehole { id:string; x:number; y:number; z:number; depth?:number; intervals:Interval[] }
export interface GeoProject { name:string; description?:string; crs?:string; base?:number; units:UnitDef[]; boreholes:Borehole[]; terrain?:TerrainGrid }

export const referenceProject:GeoProject={
  name:"Synthetic layer-cake",
  description:"Six boreholes through the same five-unit stack. Synthetic reference data, not a real site.",
  units:[
    {id:"Alluvium",name:"Alluvium",color:"#b7a58a"},
    {id:"Weathered Rock",name:"Weathered Rock",color:"#8f806d"},
    {id:"Sandstone",name:"Sandstone",color:"#c99b62"},
    {id:"Mudstone",name:"Mudstone",color:"#6f7180"},
    {id:"Granite",name:"Granite",color:"#929aa1"}
  ],
  boreholes:[
    {id:"BH-001",x:0,y:0,z:120,intervals:[{from:0,to:6,unit:"Alluvium"},{from:6,to:18,unit:"Weathered Rock"},{from:18,to:42,unit:"Sandstone"},{from:42,to:68,unit:"Mudstone"},{from:68,to:110,unit:"Granite"}]},
    {id:"BH-002",x:80,y:4,z:118,intervals:[{from:0,to:9,unit:"Alluvium"},{from:9,to:23,unit:"Weathered Rock"},{from:23,to:48,unit:"Sandstone"},{from:48,to:76,unit:"Mudstone"},{from:76,to:108,unit:"Granite"}]},
    {id:"BH-003",x:5,y:72,z:123,intervals:[{from:0,to:4,unit:"Alluvium"},{from:4,to:14,unit:"Weathered Rock"},{from:14,to:34,unit:"Sandstone"},{from:34,to:62,unit:"Mudstone"},{from:62,to:112,unit:"Granite"}]},
    {id:"BH-004",x:78,y:75,z:121,intervals:[{from:0,to:11,unit:"Alluvium"},{from:11,to:25,unit:"Weathered Rock"},{from:25,to:51,unit:"Sandstone"},{from:51,to:79,unit:"Mudstone"},{from:79,to:109,unit:"Granite"}]},
    {id:"BH-005",x:39,y:38,z:126,intervals:[{from:0,to:7,unit:"Alluvium"},{from:7,to:19,unit:"Weathered Rock"},{from:19,to:39,unit:"Sandstone"},{from:39,to:69,unit:"Mudstone"},{from:69,to:114,unit:"Granite"}]},
    {id:"BH-006",x:108,y:42,z:116,intervals:[{from:0,to:13,unit:"Alluvium"},{from:13,to:29,unit:"Weathered Rock"},{from:29,to:55,unit:"Sandstone"},{from:55,to:82,unit:"Mudstone"},{from:82,to:106,unit:"Granite"}]}
  ]
};

// JSON has no NaN: grid cells without data are stored as null.
function fromJson(p:unknown):GeoProject{
  const project=p as GeoProject;
  if(project.terrain)project.terrain={...project.terrain,z:project.terrain.z.map(v=>v===null?NaN:v)};
  return project;
}
export const valleyProject=fromJson(valleyDemo);
export const channelProject=fromJson(channelDemo);
export const sampleProjects:GeoProject[]=[valleyProject,channelProject,referenceProject];

export function boreholeDepth(b:Borehole){return Math.max(b.depth??0,...b.intervals.map(i=>i.to))}
