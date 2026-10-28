import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createAssimp} from 'libassimp';
const rss=()=>({rss:process.memoryUsage().rss,maxRss:process.resourceUsage().maxRSS*1024});
const input={name:'helical-gear.glb',bytes:new Uint8Array(readFileSync(new URL('./gear.glb',import.meta.url)))};
const engine=await createAssimp({backend:'native'});
global.gc?.();
let reset=true;try{writeFileSync('/proc/self/clear_refs','5');}catch{reset=false;}
const before=rss(),start=performance.now();
const result=await engine.convert(input,{to:'usda'});
const durationMs=performance.now()-start,after=rss();
const hashes=result.files.map(f=>({name:f.name,size:f.bytes.byteLength,sha256:createHash('sha256').update(f.bytes).digest('hex')}));
await engine.dispose();
console.log(JSON.stringify({variant:process.env.VARIANT??'release',reset,before,after,durationMs,hashes,disposed:rss()}));
