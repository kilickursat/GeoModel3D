import {GeoModel} from "./model";
import {Section} from "./section";
import {toCsv} from "./io";

// roundVe draws at a round vertical exaggeration (1, 2, 2.5, 5, 10…), as drawings state it, instead of filling the height.
export interface SectionSvgOptions { width:number; height:number; theme?:"dark"|"light"; title?:boolean; legend?:boolean; buffer?:number; roundVe?:boolean }

const THEMES={
  dark:{bg:"#0b1620",text:"#d9edf5",muted:"#8aa2ae",grid:"rgba(160,190,200,.14)",line:"#e8f5ff",hole:"#0b1620"},
  light:{bg:"#ffffff",text:"#1d2730",muted:"#5b6770",grid:"#e3e8ec",line:"#1d2730",hole:"#1d2730"}
};
const esc=(s:string)=>s.replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!));
const r2=(v:number)=>Math.round(v*100)/100;
function niceStep(range:number,count:number){
  const raw=range/Math.max(count,1),p=10**Math.floor(Math.log10(raw)),f=raw/p;
  return (f<1.5?1:f<3?2:f<7?5:10)*p;
}
const ticks=(lo:number,hi:number,count:number)=>{
  const step=niceStep(hi-lo,count),out:number[]=[];
  for(let v=Math.ceil(lo/step)*step;v<=hi+1e-9;v+=step)out.push(Math.abs(v)<1e-9?0:v);
  return out;
};
export function sectionTitle(s:Section){
  return `Section A–A′ · azimuth ${String(Math.round(s.azimuth)).padStart(3,"0")}° · offset ${s.offset>=0?"+":""}${Math.round(s.offset)} m`;
}

// 2-D cross-section: unit polygons between consecutive horizons, horizons dashed where not logged at both ends,
// boreholes within the buffer projected onto the section line.
export function sectionSvg(model:GeoModel,s:Section,o:SectionSvgOptions){
  const t=THEMES[o.theme??"dark"],W=o.width,H=o.height;
  const legendRows=o.legend?Math.ceil(model.units.length/4):0,title=o.title??true;
  const m={l:58,r:18,t:title?42:26,b:44+legendRows*18};
  let pw=W-m.l-m.r;
  const ph=H-m.t-m.b;
  const out:string[]=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, system-ui, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', Meiryo, sans-serif">`,`<rect width="${W}" height="${H}" fill="${t.bg}"/>`];
  if(title)out.push(`<text x="${m.l}" y="18" font-size="13" font-weight="600" fill="${t.text}">${esc(model.project.name)} — ${esc(sectionTitle(s))}</text>`);
  if(s.s.length<2){
    out.push(`<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="13" fill="${t.muted}">The section line does not cross the model footprint</text></svg>`);
    return out.join("");
  }
  const holes=s.boreholes.map(p=>({p,b:model.boreholes[p.index]}));
  let s0=Math.min(s.s[0],...holes.map(h=>h.p.s)),s1=Math.max(s.s[s.s.length-1],...holes.map(h=>h.p.s));
  let z0=Math.min(model.base,...holes.map(h=>h.p.bottom)),z1=Math.max(...s.z[0],...holes.map(h=>h.p.top));
  const padS=(s1-s0)*0.03||1,padZ=(z1-z0)*0.06||1;
  s0-=padS;s1+=padS;z0-=padZ;z1+=padZ;
  // Never draw a section with the vertical scale compressed below 1:1; narrow the plot instead.
  if((ph/(z1-z0))/(pw/(s1-s0))<1){const w=ph/(z1-z0)*(s1-s0);m.l+=(pw-w)/2;pw=w}
  if(o.roundVe){
    const fill=(ph/(z1-z0))/(pw/(s1-s0)),nice=[1,2,2.5,5,10,20,25,50,100,200].filter(v=>v<=fill+1e-9).pop()??1;
    const extra=ph/(nice*pw/(s1-s0))-(z1-z0);
    z0-=extra/2;z1+=extra/2;
  }
  const X=(v:number)=>m.l+(v-s0)/(s1-s0)*pw,Y=(v:number)=>m.t+(z1-v)/(z1-z0)*ph;
  const ve=(ph/(z1-z0))/(pw/(s1-s0));

  for(const v of ticks(z0,z1,6))out.push(`<line x1="${m.l}" x2="${m.l+pw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${t.grid}"/><text x="${m.l-6}" y="${(Y(v)+3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${t.muted}">${r2(v)}</text>`);
  for(const d of ticks(s0-s.s[0],s1-s.s[0],8)){
    const x=X(d+s.s[0]).toFixed(1);
    out.push(`<line x1="${x}" x2="${x}" y1="${m.t}" y2="${m.t+ph}" stroke="${t.grid}"/><text x="${x}" y="${m.t+ph+14}" text-anchor="middle" font-size="10" fill="${t.muted}">${r2(d)}</text>`);
  }

  const pt=(j:number,k:number)=>`${X(s.s[j]).toFixed(2)},${Y(s.z[k][j]).toFixed(2)}`;
  model.units.forEach((u,k)=>{
    if(s.z[k].every((z,j)=>z-s.z[k+1][j]<1e-9))return;
    const top=s.s.map((_,j)=>pt(j,k)),bottom=s.s.map((_,j)=>pt(j,k+1)).reverse();
    out.push(`<polygon points="${[...top,...bottom].join(" ")}" fill="${u.color}" stroke="${u.color}" stroke-width="0.5"><title>${esc(u.name)}</title></polygon>`);
  });
  s.z.forEach((_,k)=>{
    const last=k===s.z.length-1;
    for(let j=0;j<s.s.length-1;j++){
      const known=s.observed[k][j]&&s.observed[k][j+1];
      out.push(`<line x1="${X(s.s[j]).toFixed(2)}" y1="${Y(s.z[k][j]).toFixed(2)}" x2="${X(s.s[j+1]).toFixed(2)}" y2="${Y(s.z[k][j+1]).toFixed(2)}" stroke="${t.line}" stroke-opacity="${k===0?0.95:0.55}" stroke-width="${k===0?1.4:0.8}"${known&&!last?"":` stroke-dasharray="4 3"`}/>`);
    }
  });

  const buffer=o.buffer??Math.max(...holes.map(h=>Math.abs(h.p.offset)),1);
  // Names go to the boreholes nearest the section first, and only where they overlap no name already placed; every
  // borehole keeps its name as a tooltip.
  const placed:Array<[number,number,number,number]>=[],named=new Set<number>();
  for(const {p,b} of [...holes].sort((q,r)=>Math.abs(q.p.offset)-Math.abs(r.p.offset))){
    const x=X(p.s),y=Y(p.top)-5,w=b.id.length*5.8+4,box:[number,number,number,number]=[x-w/2,y-10,x+w/2,y+2];
    if(placed.some(q=>box[0]<q[2]&&box[2]>q[0]&&box[1]<q[3]&&box[3]>q[1]))continue;
    placed.push(box);
    named.add(p.index);
  }
  for(const {p,b} of holes){
    const x=X(p.s),fade=(1-0.55*Math.min(Math.abs(p.offset)/buffer,1)).toFixed(2);
    out.push(`<g opacity="${fade}"><title>${esc(b.id)}: ${Math.round(Math.abs(p.offset))} m ${p.offset>=0?"right":"left"} of the section</title>`);
    for(const i of b.intervals){
      const u=model.units.find(q=>q.id===i.unit);
      out.push(`<rect x="${(x-3).toFixed(2)}" y="${Y(b.z-i.from).toFixed(2)}" width="6" height="${Math.max(Y(b.z-i.to)-Y(b.z-i.from),0.5).toFixed(2)}" fill="${u?.color??"#999999"}" stroke="${t.hole}" stroke-width="0.6"/>`);
    }
    out.push(`<line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${Y(p.top).toFixed(2)}" y2="${Y(p.bottom).toFixed(2)}" stroke="${t.line}" stroke-width="0.6" stroke-opacity="0.6"/>`);
    out.push(`${named.has(p.index)?`<text x="${x.toFixed(2)}" y="${(Y(p.top)-5).toFixed(2)}" text-anchor="middle" font-size="9.5" fill="${t.text}">${esc(b.id)}</text>`:""}</g>`);
  }

  const a={x:s.x[0],y:s.y[0]},b={x:s.x[s.x.length-1],y:s.y[s.y.length-1]};
  out.push(`<text x="${X(s.s[0])}" y="${m.t-8}" font-size="10" fill="${t.muted}">A  (${r2(a.x)}, ${r2(a.y)})</text>`);
  out.push(`<text x="${X(s.s[s.s.length-1])}" y="${m.t-8}" text-anchor="end" font-size="10" fill="${t.muted}">A′  (${r2(b.x)}, ${r2(b.y)})</text>`);
  out.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="${t.muted}" stroke-opacity="0.5"/>`);
  out.push(`<text x="${m.l+pw/2}" y="${m.t+ph+30}" text-anchor="middle" font-size="10.5" fill="${t.muted}">Distance along section (m) · V.E. ×${ve<10?ve.toFixed(1):Math.round(ve)} · dashed = inferred</text>`);
  out.push(`<text transform="translate(${m.l-44} ${m.t+ph/2}) rotate(-90)" text-anchor="middle" font-size="10.5" fill="${t.muted}">Elevation (m)</text>`);
  if(o.legend)model.units.forEach((u,k)=>{
    const lx=m.l+(k%4)*Math.min(pw/4,190),ly=H-12-(legendRows-1-Math.floor(k/4))*18;
    out.push(`<rect x="${lx}" y="${ly-9}" width="10" height="10" fill="${u.color}"/><text x="${lx+15}" y="${ly}" font-size="10.5" fill="${t.text}">${esc(u.name)}</text>`);
  });
  out.push("</svg>");
  return out.join("");
}

export function sectionCsv(model:GeoModel,s:Section){
  const rows:Array<Array<string|number>>=[["distance_m","x","y",...model.horizons.map(h=>h.name+" z")]];
  s.s.forEach((v,j)=>rows.push([r2(v-s.s[0]),r2(s.x[j]),r2(s.y[j]),...s.z.map(z=>r2(z[j]))]));
  return toCsv(rows);
}
