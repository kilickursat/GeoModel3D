// The browser tests' web server: the production build in dist/, plus the few source modules the test fixtures import
// (see tests/browser/serve.mjs). Playwright starts it after npm run build.
//   node scripts/ui-test-server.mjs [port]
import {createServer} from "node:http";
import {createUiResponder} from "../tests/browser/serve.mjs";

const port=Number(process.argv[2]??4173);
const respond=await createUiResponder();
createServer(async(request,response)=>{
  try{
    const url=new URL(request.url??"/","http://127.0.0.1");
    const result=await respond(url.pathname,url.search);
    response.writeHead(result.status,{"content-type":result.type,"cache-control":"no-store"});
    response.end(result.body);
  }catch(error){
    response.writeHead(500,{"content-type":"text/plain"});
    response.end(String(error instanceof Error?error.message:error));
  }
}).listen(port,"127.0.0.1",()=>console.log(`Browser tests: dist/ on http://127.0.0.1:${port}`));
