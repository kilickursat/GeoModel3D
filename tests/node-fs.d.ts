// The one Node API the tests use to read binary fixtures; the project does not depend on Node's type definitions.
declare module "node:fs" {
  export function readFileSync(path:URL|string):Uint8Array;
}
