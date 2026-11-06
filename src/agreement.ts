// Reading PDFs needs the user's agreement first. The text says what reading does and what it does not do. Agree is kept
// in this browser with the version of the text and the date, and can be withdrawn under Help; Disagree leaves the PDF
// unread and the rest of the app as it was. A new version of the text asks again.
const KEY="geomodel3d.pdf-reading";
export const AGREEMENT_VERSION=1;
export interface Agreement { version:number; date:string }
// Where the browser keeps nothing (a private window, blocked site data), the answer holds while the page is open.
let held:Agreement|null=null;

export function agreement():Agreement|null{
  try{
    const a=JSON.parse(localStorage.getItem(KEY)??"null");
    if(a?.version===AGREEMENT_VERSION&&typeof a.date==="string")return a;
  }catch{/* nothing kept */}
  return held?.version===AGREEMENT_VERSION?held:null;
}
export function withdrawAgreement(){
  held=null;
  try{localStorage.removeItem(KEY)}catch{/* nothing kept */}
}

// Asks, and resolves true once the user agrees. Escape, like Disagree, leaves the PDF unread.
export function askAgreement():Promise<boolean>{
  return new Promise(resolve=>{
    const d=document.createElement("dialog");
    d.className="agree";
    d.setAttribute("aria-labelledby","agree-title");
    d.innerHTML=`<h2 id="agree-title">Read borehole logs from PDFs</h2>
<ul>
<li><b>On this device.</b> GeoModel3D reads the PDF here, in this browser. The document is not uploaded or sent anywhere.</li>
<li><b>You check every value.</b> Reading is automatic and can be wrong. Before you use a borehole, compare its depths, descriptions, levels and position with the document. The review shows where each value was read, and marks the values to check.</li>
<li><b>Digital PDFs.</b> Pages with text are read. Scanned pages are listed as not read, for now.</li>
</ul>
<p>If you disagree, the PDF is not read, and everything else works as before. Your answer is kept in this browser; you can withdraw it under Help (?).</p>
<div class="agree-actions"><button value="no">Disagree</button><button value="yes" class="agree-yes">Agree</button></div>`;
    const done=(yes:boolean)=>{
      if(yes){
        held={version:AGREEMENT_VERSION,date:new Date().toISOString().slice(0,10)};
        try{localStorage.setItem(KEY,JSON.stringify(held))}catch{/* held for this page */}
      }
      d.close();d.remove();resolve(yes);
    };
    d.addEventListener("cancel",e=>{e.preventDefault();done(false)});
    d.addEventListener("click",e=>{const b=(e.target as Element).closest("button");if(b)done(b.value==="yes")});
    document.body.appendChild(d);
    d.showModal();
  });
}
