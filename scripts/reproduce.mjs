import path from 'node:path';
import { Engine } from '../src/engine.mjs';
if (!process.env.FEROX_DATA || !process.argv[2])
  throw new Error('Usage: FEROX_DATA=<run directory> npm run reproduce -- <candidate id>');
const engine = await new Engine(path.resolve(process.env.FEROX_DATA)).init();
const result = await engine.reproduce(process.argv[2]);
console.log(result.output);
process.exitCode = result.code;
