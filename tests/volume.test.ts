import {describe,it,expect} from "vitest";
import {volumeGeometry} from "../src/volume";
import {buildGeologicalModel,unitVolume,unitCubicMetres,modelBounds} from "../src/model";
import {referenceProject,valleyProject} from "../src/geology";
import {boundaryEdges} from "../src/tin";
import {meshVolume,openEdges} from "./helpers";

describe("unit volume meshes",()=>{
  for(const project of [referenceProject,valleyProject]){
    const m=buildGeologicalModel(project),b=modelBounds(m);
    const origin={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2,z:(b.minZ+b.maxZ)/2};

    it(`${project.name}: closed, outward-facing shells enclosing the exact unit volume`,()=>{
      m.units.forEach((_,u)=>{
        const g=volumeGeometry(unitVolume(m,u),origin);
        const exact=unitCubicMetres(m,u),mesh=meshVolume(g.positions,g.indices);
        expect(openEdges(g.indices)).toEqual([]);
        expect(exact).toBeGreaterThan(0);
        expect(Math.abs(mesh-exact)/exact).toBeLessThan(1e-5);
      });
    });
  }

  it("adds no faces where a unit is absent from all three corners of a triangle",()=>{
    const m=buildGeologicalModel(valleyProject);
    const u=m.units.findIndex(x=>x.id==="Terrace Gravel");
    const pinched=m.triangles.filter(t=>[t.a,t.b,t.c].every(i=>m.horizons[u].z[i]===m.horizons[u+1].z[i])).length;
    expect(pinched).toBeGreaterThan(0);
    const faces=volumeGeometry(unitVolume(m,u)).indices.length/3;
    expect(faces).toBeLessThanOrEqual(2*(m.triangles.length-pinched)+2*boundaryEdges(m.triangles).length);
  });
});
