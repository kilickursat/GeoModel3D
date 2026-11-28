import {describe,expect,it} from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {extractPageText,scanReason} from "../src/docread/pdfpage";
import {readPageImage} from "../src/docread/ocrclient";

// Minimal single-page PDF. The image and both text layers are emitted as actual drawing commands.
async function readTestPdf(content:string){
  const objects=[
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Scan 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n1234\nendstream",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf="%PDF-1.4\n";
  const offsets=objects.map((body,i)=>{
    const start=pdf.length;
    pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;
    return start;
  });
  const xref=pdf.length;
  pdf+=`xref\n0 7\n0000000000 65535 f \n${offsets.map(n=>n.toString().padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const task=pdfjs.getDocument({data:new TextEncoder().encode(pdf),standardFontDataUrl:"node_modules/pdfjs-dist/standard_fonts/",verbosity:0});
  try{return await extractPageText(await (await task.promise).getPage(1),pdfjs.OPS)}
  finally{await task.destroy()}
}
const scan="q 200 0 0 200 0 0 cm /Scan Do Q";
const hidden="q BT /F1 8 Tf 3 Tr 10 80 Td (Brown sand with coarse gravel and stiff grey clay) Tj ET Q";
const visible="BT /F1 8 Tf 10 100 Td (Description) Tj ET";

describe("scan routing",()=>{
  it("reads an image with exclusively invisible text by local OCR even if its text looks like ordinary words",async()=>{
    const page=await readTestPdf(scan+" "+hidden);
    expect(page.share).toBe(1);
    expect(scanReason(page)).toBe("a scan whose text is another program's OCR");
  });
  it("keeps visible PDF text after restoring the graphics state, and invisible-only text without a scan",async()=>{
    for(const content of [scan+" "+hidden+" "+visible,hidden]){
      const page=await readTestPdf(content);
      expect(page.layer).toBe("good");
      expect(scanReason(page)).toBeUndefined();
    }
  });
  it("extracts the ruled boundary before the worker takes ownership of the image",async()=>{
    const width=100,height=50,data=new Uint8ClampedArray(width*height*4).fill(255);
    data.fill(0,4*(25*width+12),4*(25*width+88));
    const page=await readPageImage({async read(img){
      structuredClone(img.data.buffer,{transfer:[img.data.buffer]});
      return [];
    }},{width,height,data} as ImageData);
    expect(data.byteLength).toBe(0);
    expect(page.width).toBe(width);
    expect(page.rules).toHaveLength(1);
    expect(page.rules[0]).toMatchObject({x0:12,x1:87});
  });
});
