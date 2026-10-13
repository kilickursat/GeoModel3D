// The project schema: units, boreholes and their logs, tests and water levels, and the project itself. It holds no
// data, so the modelling kernel (and a worker running it) can use it without the bundled datasets in src/geology.ts.
import {TerrainGrid} from "./terrain";

// Geological units are listed in stratigraphic order, youngest (top) to oldest (bottom). An erosive unit's base
// is an unconformity that cuts down into older units. Unit weights are in kN/m³; `params` holds other design values
// keyed as in src/properties.ts (c, phi, su, E, k…); `source` records where the properties come from.
export interface UnitDef { id:string; name:string; color:string; erosive?:boolean; gamma?:number; gammaSat?:number; params?:Record<string,number>; source?:string }
// Depths are metres below the collar; `unit` refers to UnitDef.id. `name` is the logged description (soil or rock
// name) when units are assigned to descriptions by the project's rules.
export interface Interval { from:number; to:number; unit:string; name?:string }
// Standard penetration test: blows for the penetration in millimetres (300 for a complete test).
export interface SptTest { depth:number; blows:number; penetration:number }
export interface WaterLevel { depth:number; date?:string }
// A laboratory test on a sample, or an in-situ test, at `depth` (to `to` for a sample over a depth range). `property`
// is a key of the catalogue in src/properties.ts (w, gamma, su…) or any other name; `value` is in that property's unit.
export interface TestResult { depth:number; to?:number; property:string; value:number }
// Collar position (x, y) and elevation (z) in the project coordinate system; `depth` is the final depth when it
// exceeds the logged intervals. `lon`, `lat` keep the surveyed geographic position, so the collar can be placed again
// in another coordinate system.
export interface Borehole { id:string; x:number; y:number; z:number; depth?:number; intervals:Interval[]; lon?:number; lat?:number; spt?:SptTest[]; water?:WaterLevel[]; tests?:TestResult[] }
// Assigns a unit to every logged description that matches the regular expression `match` (case-insensitive) and,
// when given, whose median SPT N-value in the interval lies in [minN, maxN) and whose top elevation lies in
// [minZ, maxZ). The first matching rule wins.
export interface UnitRule { match:string; unit:string; minN?:number; maxN?:number; minZ?:number; maxZ?:number }
// x, y are in the system named by `crs`; `crsCode` (e.g. EPSG:6677) or the PROJ definition `crsProj4` georeferences it.
// `source` credits where the data come from. `groundwaterDepth` is an assumed depth of the water table below ground,
// used where no borehole records a water level. `margin` extends the model that many metres beyond the outline of the
// boreholes (by default it ends at the outermost boreholes).
export interface GeoProject {
  name:string; description?:string; source?:string; crs?:string; crsCode?:string; crsProj4?:string; base?:number;
  groundwaterDepth?:number; margin?:number;
  units:UnitDef[]; rules?:UnitRule[]; boreholes:Borehole[]; terrain?:TerrainGrid;
}

export function boreholeDepth(b:Borehole){return Math.max(b.depth??0,...b.intervals.map(i=>i.to))}
// SPT N-value; a test stopped short of 300 mm is scaled to 300 mm (a converted N-value).
export const sptN=(t:SptTest)=>t.penetration>=300?t.blows:t.blows*300/Math.max(t.penetration,1);
