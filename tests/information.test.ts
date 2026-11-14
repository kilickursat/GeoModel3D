import {describe,it,expect} from "vitest";
import {contactBins,conditionalCaseEntropy,conditionalInformationGain,informationPriors,informationSettings} from "../src/information";

describe("finite-case expected information",()=>{
  it("gives one bit for two equally weighted distinguishable cases and zero for the same observation",()=>{
    expect(conditionalCaseEntropy([.5,.5])).toBe(1);
    expect(conditionalInformationGain([.5,.5],[],[2,3])).toBe(1);
    expect(conditionalInformationGain([.5,.5],[],[2,2])).toBe(0);
    expect(conditionalInformationGain([.5,.5],[[2,3]],[9,10])).toBe(0);
  });
  it("integrates all outcomes jointly rather than treating repeated sites as independent information",()=>{
    const p=[.25,.25,.25,.25],first=[0,0,1,1],second=[0,1,0,1];
    expect(conditionalCaseEntropy(p)).toBe(2);
    expect(conditionalInformationGain(p,[],first)).toBe(1);
    expect(conditionalInformationGain(p,[first],first)).toBe(0);
    expect(conditionalInformationGain(p,[first],second)).toBe(1);
    expect(conditionalCaseEntropy(p,[first,second])).toBe(0);
  });
  it("uses supplied prior weights, including zero-weight cases, without inventing posterior certainty",()=>{
    const expected=-.9*Math.log2(.9)-.1*Math.log2(.1);
    expect(conditionalInformationGain([9,1],[],[1,2])).toBeCloseTo(expected,14);
    expect(informationPriors(3,[1e308,1e308,0])).toEqual([.5,.5,0]);
    expect(conditionalInformationGain([1,0],[],[1,2])).toBe(0);
  });
  it("makes bin resolution and origin observable assumptions, including a tiny difference across an edge",()=>{
    expect(contactBins([7.999,8.001],1)).toEqual([7,8]);
    expect(conditionalInformationGain([1,1],[],contactBins([7.999,8.001],1))).toBe(1);
    expect(contactBins([7.999,8.001],1,.5)).toEqual([7,7]);
    expect(conditionalInformationGain([1,1],[],contactBins([7.999,8.001],1,.5))).toBe(0);
    expect(contactBins([-1.1,-.9],1)).toEqual([-2,-1]);
  });
  it("rejects invalid channels, priors and cost settings",()=>{
    for(const weights of [[0,0],[-1,2],[1],[1,NaN],[1,Infinity]])expect(()=>informationPriors(2,weights)).toThrow(/priors/);
    expect(()=>conditionalCaseEntropy([1,1],[[0]])).toThrow(/Every observation/);
    expect(()=>contactBins([1],0)).toThrow(/resolution/);
    expect(()=>contactBins([Infinity],1)).toThrow(/represented safely/);
    expect(()=>contactBins([1],1e-100)).toThrow(/represented safely/);
    const options={resolution:1,moneyBudget:100,fixedCost:10,costPerMetre:0};
    expect(informationSettings(options,2)).toMatchObject({origin:0,priors:[.5,.5],contactBuffer:0,currency:"cost units"});
    for(const moneyBudget of [0,-1,NaN,Infinity])expect(()=>informationSettings({...options,moneyBudget},2)).toThrow(/monetary budget/);
    for(const costPerMetre of [-1,NaN,Infinity])expect(()=>informationSettings({...options,costPerMetre},2)).toThrow(/cost/);
    expect(()=>informationSettings({...options,fixedCost:0},2)).toThrow(/positive fixed cost/);
  });
});
