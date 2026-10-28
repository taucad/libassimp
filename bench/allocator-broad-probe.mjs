import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createAssimp} from 'libassimp';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = {name: process.env.INPUT, bytes: new Uint8Array(readFileSync(process.env.INPUT))};
const engine = await createAssimp({backend: 'native'});
global.gc?.();
try { writeFileSync('/proc/self/clear_refs', '5'); } catch {}
const start = performance.now();
const result = await engine.convert(input, {to: process.env.TARGET});
const durationMs = performance.now() - start;
const peakBytes = process.resourceUsage().maxRSS * 1024;
const outputs = result.files.map(file => ({name: file.name, size: file.bytes.length, sha256: hash(file.bytes)}));
const roundtrip = await engine.convert(result.files[0], {to: 'glb'});
const roundtripHashes = roundtrip.files.map(file => ({name: file.name, size: file.bytes.length, sha256: hash(file.bytes)}));
await engine.dispose();
console.log(JSON.stringify({variant: process.env.VARIANT, input: input.name, inputSha256: hash(input.bytes), target: process.env.TARGET, durationMs, peakBytes, outputs, roundtripHashes}));
