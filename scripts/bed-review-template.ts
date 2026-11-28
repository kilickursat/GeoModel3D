import {readFileSync} from "node:fs";
import {importFiles} from "../src/io";
import {toBedReviewCsv} from "../src/bedReviewCsv";

const args=process.argv.slice(2);
if(args.length!==1)throw new Error("Supply one saved GeoModel3D case JSON file.");
const [name]=args;
const {project}=importFiles([{name,text:readFileSync(name,"utf8")}]);
process.stdout.write(toBedReviewCsv(project));
