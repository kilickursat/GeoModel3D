// Short invented DOV exports. Interpretation records deliberately travel separately from their collars.
const xml=(name:string,body:string)=>({name,text:`<dov xmlns="http://kern.schemas.dov.vlaanderen.be" xmlns:gml="http://www.opengis.net/gml/3.2">${body}</dov>`});
const ids=["FICTION-BE-A","FICTION-BE-B","FICTION-BE-C"];
export const collars=ids.map((id,i)=>xml(`collar-${i}.xml`,`<boring><identificatie>${id}</identificatie><dataidentifier><permkey>invented-${i}</permkey></dataidentifier>
  <ligging><gml:Point srsName="urn:ogc:def:crs:EPSG::6190"><gml:pos>${150000+30*i} ${180000+7*i} 12</gml:pos></gml:Point></ligging><diepte_tot>15</diepte_tot><datum_aanvang>2040-02-15</datum_aanvang></boring>`));
const layer=(from:number,to:number,tag:string,value:string)=>`<laag><van>${from}</van><tot>${to}</tot><${tag}>${value}</${tag}></laag>`;
export const formal=ids.map((id,i)=>xml(`formal-${i}.xml`,`<interpretaties><formelestratigrafie><boring>${id}</boring><datum>2040-04-12</datum>
  ${layer(0,1.25,"lid1","A")}${layer(1.25,7.75,"lid1","Kd")}${layer(7.75,15,"lid1","BcAn")}</formelestratigrafie></interpretaties>`));
export const descriptions=xml("descriptions.xml",`<interpretaties><lithologischebeschrijving><boring>${ids[0]}</boring>
  ${layer(0,1,"beschrijving","Terrain rapporté")}${layer(1,4,"beschrijving","Sable gris")}${layer(4,6,"beschrijving","Gravier brun")}${layer(6,9,"beschrijving","Argile grise")}${layer(9,15,"beschrijving","Matière inconnue")}</lithologischebeschrijving></interpretaties>`);
