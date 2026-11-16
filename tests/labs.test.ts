import {describe,it,expect} from "vitest";
import {labEnabled} from "../src/labs";

describe("labs",()=>{
  it("enables an experimental tool only when the address names it",()=>{
    expect(labEnabled("core-ai","")).toBe(false);
    expect(labEnabled("core-ai","?backend=webgl")).toBe(false);
    expect(labEnabled("core-ai","?labs=core-ai")).toBe(true);
    expect(labEnabled("core-ai","?backend=webgl&labs=other,%20core-ai")).toBe(true);
    expect(labEnabled("core-ai","?labs=core-ai-extra")).toBe(false);
  });
});
