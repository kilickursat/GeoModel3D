export type Lithology="Alluvium"|"Weathered Rock"|"Sandstone"|"Mudstone"|"Granite";
export interface Interval{from:number;to:number;lithology:Lithology}
export interface Borehole{id:string;x:number;y:number;z:number;intervals:Interval[]}
export interface ContactPoint{x:number;y:number;z:number;unit:Lithology}
export const COLORS:Record<Lithology,number>={Alluvium:0xb7a58a,"Weathered Rock":0x8f806d,Sandstone:0xc99b62,Mudstone:0x6f7180,Granite:0x929aa1};
export const sampleBoreholes:Borehole[]=[
{id:"BH-001",x:0,y:0,z:120,intervals:[{from:0,to:6,lithology:"Alluvium"},{from:6,to:18,lithology:"Weathered Rock"},{from:18,to:42,lithology:"Sandstone"},{from:42,to:68,lithology:"Mudstone"},{from:68,to:110,lithology:"Granite"}]},
{id:"BH-002",x:80,y:4,z:118,intervals:[{from:0,to:9,lithology:"Alluvium"},{from:9,to:23,lithology:"Weathered Rock"},{from:23,to:48,lithology:"Sandstone"},{from:48,to:76,lithology:"Mudstone"},{from:76,to:108,lithology:"Granite"}]},
{id:"BH-003",x:5,y:72,z:123,intervals:[{from:0,to:4,lithology:"Alluvium"},{from:4,to:14,lithology:"Weathered Rock"},{from:14,to:34,lithology:"Sandstone"},{from:34,to:62,lithology:"Mudstone"},{from:62,to:112,lithology:"Granite"}]},
{id:"BH-004",x:78,y:75,z:121,intervals:[{from:0,to:11,lithology:"Alluvium"},{from:11,to:25,lithology:"Weathered Rock"},{from:25,to:51,lithology:"Sandstone"},{from:51,to:79,lithology:"Mudstone"},{from:79,to:109,lithology:"Granite"}]},
{id:"BH-005",x:39,y:38,z:126,intervals:[{from:0,to:7,lithology:"Alluvium"},{from:7,to:19,lithology:"Weathered Rock"},{from:19,to:39,lithology:"Sandstone"},{from:39,to:69,lithology:"Mudstone"},{from:69,to:114,lithology:"Granite"}]},
{id:"BH-006",x:108,y:42,z:116,intervals:[{from:0,to:13,lithology:"Alluvium"},{from:13,to:29,lithology:"Weathered Rock"},{from:29,to:55,lithology:"Sandstone"},{from:55,to:82,lithology:"Mudstone"},{from:82,to:106,lithology:"Granite"}]}];
export function contactsFromBoreholes(bs:Borehole[]):ContactPoint[]{const out:ContactPoint[]=[];for(const b of bs)for(const i of b.intervals)out.push({x:b.x,y:b.y,z:b.z-i.to,unit:i.lithology});return out}
