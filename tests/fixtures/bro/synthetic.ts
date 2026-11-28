// Invented field logs and lab measurements for the IMBRO BHR-GT reader.
const lab=`<investigatedInterval><beginDepth>1.4</beginDepth><endDepth>1.7</endDepth>
  <waterContentDetermination><determinationResult><waterContent>34.2</waterContent></determinationResult></waterContentDetermination>
  <consistencyLimitsDetermination><liquidLimit>45</liquidLimit><plasticLimit>28</plasticLimit><plasticityIndex>17</plasticityIndex><waterContent>99</waterContent></consistencyLimitsDetermination>
  <volumetricMassDensityDetermination><volumetricMassDensity>1.7</volumetricMassDensity></volumetricMassDensityDetermination>
  <organicMatterContentDetermination><organicMatterContent>4</organicMatterContent></organicMatterContentDetermination>
  <particleSizeDistributionDetermination><fractionSmaller63um>38</fractionSmaller63um></particleSizeDistributionDetermination>
  <maximumUndrainedShearStrengthDetermination><maximumUndrainedShearStrength>32</maximumUndrainedShearStrength></maximumUndrainedShearStrengthDetermination></investigatedInterval>
  <investigatedInterval><beginDepth>2.1</beginDepth><endDepth>2.3</endDepth><consistencyLimitsDetermination><liquidLimit>48</liquidLimit></consistencyLimitsDetermination></investigatedInterval>`;
function log(id:string,projected:string,geographic:string,madeGround:boolean){
  const layer=(from:number,to:number,name:string,made=false)=>`<layer><upperBoundary>${from}</upperBoundary><lowerBoundary>${to}</lowerBoundary><soil><geotechnicalSoilName>${name}</geotechnicalSoilName></soil><anthropogenic>${made?"ja":"nee"}</anthropogenic></layer>`;
  const upper=madeGround?layer(0,0.5,"zand",true)+layer(0.5,2.5,"klei"):layer(0,2.5,"klei");
  return `<BHR_GT_O xmlns="http://www.broservices.nl/xsd/dsbhr-gt/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"><broId>${id}</broId>
    <deliveredLocation><gml:Point srsName="urn:ogc:def:crs:EPSG::28992"><gml:pos>${projected}</gml:pos></gml:Point></deliveredLocation>
    <standardizedLocation><location srsName="urn:ogc:def:crs:EPSG::4258"><gml:pos>${geographic}</gml:pos></location></standardizedLocation>
    <deliveredVerticalPosition><localVerticalReferencePoint>maaiveld</localVerticalReferencePoint><verticalDatum>NAP</verticalDatum><offset>-2.75</offset></deliveredVerticalPosition>
    <boring><finalDepthBoring>6.5</finalDepthBoring><groundwaterLevel>1.8</groundwaterLevel></boring>
    <descriptiveBoreholeLog><descriptionLocation>veld</descriptionLocation>${upper}${layer(2.5,6.5,"zand")}</descriptiveBoreholeLog>${madeGround?"":lab}</BHR_GT_O>`;
}
export const dutchXml=[
  {name:"invented-clay.xml",text:log("FICTION-NL-A","155000 463000","52.155172294 5.387203505",false)},
  {name:"invented-fill.xml",text:log("FICTION-NL-B","120000 460000","52.127101324 4.876081616",true)}
];
