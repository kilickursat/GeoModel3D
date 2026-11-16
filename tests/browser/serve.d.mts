export interface UiResponse { status:number;type:string;body:string|Uint8Array }
export function createUiResponder():Promise<(pathname:string,search?:string)=>Promise<UiResponse>>;
