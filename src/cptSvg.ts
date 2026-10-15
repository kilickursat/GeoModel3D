// A CPT's log: the cone resistance and the friction ratio against elevation, side by side, over the units of the model
// where the CPT stands; for the read-out in the app and the report.
import {Cpt,cptDepth} from "./schema";
import {frictionRatio,thinned,cptScale,RF_SCALE} from "./cpt";

// `units`: the model's units at the CPT, as elevation bands; `marker`: a depth to mark; `zRange`: the elevations shown
// (top, bottom), shared by logs drawn side by side; `qcMax`: the full scale of qc in MPa.
export interface CptBand { top:number; bottom:number; color:string; name:string }
export interface CptLogOptions { width:number; height:number; theme?:"dark"|"light"; marker?:number; units?:CptBand[]; qcMax?:number; zRange?:[number,number]; title?:boolean }

const THEMES={
  dark:{bg:"#0b1620",text:"#d9edf5",muted:"#8aa2ae",grid:"rgba(160,190,200,.16)",line:"#e8f5ff",marker:"#78c9df",frame:"rgba(160,190,200,.4)"},
  light:{bg:"#ffffff",text:"#1d2730",muted:"#5b6770",grid:"#e3e8ec",line:"#1d2730",marker:"#1f6fd1",frame:"#9aa6ad"}
};
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const r2=(v:number)=>String(Math.round(v*100)/100);
function niceStep(range:number,count:number){
  const raw=range/Math.max(count,1),p=10**Math.floor(Math.log10(raw)),f=raw/p;
  return (f<1.5?1:f<3?2:f<7?5:10)*p;
}

export function cptLogSvg(c:Cpt,o:CptLogOptions){
  const t=THEMES[o.theme??"dark"],W=o.width,H=o.height,bottom=c.z-cptDepth(c);
  const m={l:36,r:6,t:o.title?34:22,b:8},gap=8,pw=W-m.l-m.r-gap,qw=Math.round(pw*0.66),rw=pw-qw,ph=H-m.t-m.b;
  const pad=Math.max(0.3,(c.z-bottom)*0.02),[top,low]=o.zRange??[c.z+pad,bottom-pad];
  const Y=(e:number)=>m.t+(top-e)/(top-low)*ph,qcMax=o.qcMax??cptScale(Math.max(...c.qc.filter(Number.isFinite),1));
  const qx=m.l,rx=m.l+qw+gap,out:string[]=[];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, system-ui, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', Meiryo, sans-serif">`);
  if(o.title)out.push(`<text x="${m.l}" y="12" font-size="11" font-weight="600" fill="${t.text}">${esc(c.id)}</text>`);
  // The units of the model behind both panels, faint, so the readings stay in front.
  for(const u of o.units??[]){
    const y0=Math.max(m.t,Y(u.top)),y1=Math.min(m.t+ph,Y(u.bottom));
    if(y1-y0<0.2)continue;
    for(const [x,w] of [[qx,qw],[rx,rw]])out.push(`<rect x="${x}" y="${y0.toFixed(1)}" width="${w}" height="${(y1-y0).toFixed(1)}" fill="${u.color}" fill-opacity="0.45"><title>${esc(u.name)}</title></rect>`);
  }
  // Elevation grid and labels; the scale of each panel above it.
  const step=niceStep(top-low,6);
  for(let v=Math.ceil(low/step)*step;v<=top+1e-9;v+=step){
    const y=Y(v).toFixed(1);
    out.push(`<line x1="${qx}" x2="${rx+rw}" y1="${y}" y2="${y}" stroke="${t.grid}"/><text x="${m.l-4}" y="${(Y(v)+3).toFixed(1)}" text-anchor="end" font-size="9" fill="${t.muted}">${r2(Math.abs(v)<1e-9?0:v)}</text>`);
  }
  for(const f of [0.5,1])out.push(`<line x1="${(qx+qw*f).toFixed(1)}" x2="${(qx+qw*f).toFixed(1)}" y1="${m.t}" y2="${m.t+ph}" stroke="${t.grid}"/>`);
  out.push(`<line x1="${(rx+rw/2).toFixed(1)}" x2="${(rx+rw/2).toFixed(1)}" y1="${m.t}" y2="${m.t+ph}" stroke="${t.grid}"/>`);
  out.push(`<text x="${qx}" y="${m.t-5}" font-size="9" fill="${t.muted}">qc 0–${qcMax} MPa</text><text x="${rx}" y="${m.t-5}" font-size="9" fill="${t.muted}">Rf 0–${RF_SCALE} %</text>`);
  // The readings, about one point a pixel; values beyond the scale at its edge.
  const keep=thinned(c,Math.max(0.02,0.8*(top-low)/ph)),rf=frictionRatio(c);
  const path=(x:(i:number)=>number)=>{let d="",pen=false;for(const i of keep){const v=x(i);if(!Number.isFinite(v)){pen=false;continue}d+=`${pen?"L":"M"}${v.toFixed(1)},${Y(c.z-c.depth[i]).toFixed(1)}`;pen=true}return d};
  const qd=path(i=>Number.isFinite(c.qc[i])?qx+Math.min(Math.max(c.qc[i],0),qcMax)/qcMax*qw:NaN);
  const rd=path(i=>Number.isFinite(rf[i])?rx+Math.min(Math.max(rf[i],0),RF_SCALE)/RF_SCALE*rw:NaN);
  if(qd)out.push(`<path d="${qd}" fill="none" stroke="${t.line}" stroke-width="1.1" stroke-linejoin="round"/>`);
  if(rd)out.push(`<path d="${rd}" fill="none" stroke="${t.line}" stroke-width="0.9" stroke-linejoin="round"/>`);
  if(o.marker!==undefined&&Number.isFinite(o.marker)){
    const y=Y(c.z-o.marker).toFixed(1);
    out.push(`<line x1="${qx}" x2="${rx+rw}" y1="${y}" y2="${y}" stroke="${t.marker}" stroke-width="1.2"/>`);
  }
  for(const [x,w] of [[qx,qw],[rx,rw]])out.push(`<rect x="${x}" y="${m.t}" width="${w}" height="${ph}" fill="none" stroke="${t.frame}" stroke-width="0.6"/>`);
  out.push("</svg>");
  return out.join("");
}
