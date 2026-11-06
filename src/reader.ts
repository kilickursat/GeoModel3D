// The PDF reader (src/docread/), loaded the first time a PDF is read. The import is made here, not in main.ts: main.ts
// awaits the renderer at its top level, and Rollup then keeps every module the reader shares with the app in a chunk
// of its own (against a deadlock that cannot happen here, as nothing awaits the reader while the app starts). The
// offline file inlines one script, so the app's modules must stay in it.
export const loadReader=()=>import("./docread/index");
