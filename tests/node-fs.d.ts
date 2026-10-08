// The parts of node:fs the tests use, so the type check needs no Node type package.
declare module "node:fs" {
  export function readFileSync(path:string|URL):Uint8Array;
  export function readFileSync(path:string|URL,encoding:"utf8"):string;
  export function readdirSync(path:string|URL):string[];
}
