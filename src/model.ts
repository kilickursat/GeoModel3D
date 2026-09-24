import {Borehole,Lithology} from "./geology";
import {buildSurface,TINSurface,GeologicalVolume} from "./volume";
export interface HorizonSet {ground:TINSurface; bottoms:Map<Lithology,TINSurface>; volumes:GeologicalVolume[]}
export function buildGeologicalModel(boreholes:Borehole[],units:Lithology[]):HorizonSet{
  const groundPoints=boreholes.map(b=>({x:b.x,y:b.y,z:b.z}));
  const bottoms=new Map<Lithology,TINSurface>();
  for(const unit of units){
    const points=boreholes.map(b=>{
      const interval=b.intervals.find(i=>i.lithology===unit);
      return {x:b.x,y:b.y,z:interval?b.z-interval.to:b.z-1};
    });
    bottoms.set(unit,buildSurface(unit,points));
  }
  const ground=buildSurface("Ground",groundPoints);
  const volumes:GeologicalVolume[]=[]; let top=ground;
  for(const unit of units){const bottom=bottoms.get(unit)!;volumes.push({unit,top,bottom});top=bottom}
  return{ground,bottoms,volumes};
}
