// Writes src/data/dov-stratigraphy.json: the codes of the formal lithostratigraphy of Flanders used by DOV
// (Databank Ondergrond Vlaanderen) and their names, from DOV's published XML schema code list.
import {writeFileSync} from "node:fs";

const url="https://www.dov.vlaanderen.be/xdov/schema/latest/xsd/kern/interpretatie/FormeleStratigrafieDataCodes.xsd";
const xsd=await (await fetch(url)).text();
const type=xsd.match(/<xs:simpleType name="FormeleStratigrafieLedenEnumType">([\s\S]*?)<\/xs:simpleType>/)[1];
const codes={};
for(const m of type.matchAll(/<xs:enumeration value="([^"]*)">\s*<xs:annotation>\s*<xs:documentation>([^<]*)<\/xs:documentation>/g))codes[m[1]]=m[2].trim();
writeFileSync(new URL("../src/data/dov-stratigraphy.json",import.meta.url),JSON.stringify({source:url,codes})+"\n");
console.log(Object.keys(codes).length,"codes");
