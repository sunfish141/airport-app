import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function checkFirmwareBuild() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'app/public/firmware/manifest.json')));
  const digest = createHash('sha256');
  for (const path of manifest.sources) digest.update(path).update('\0').update(readFileSync(resolve(root, path))).update('\0');
  const wasmHash = createHash('sha256').update(readFileSync(resolve(root, 'app/public/firmware/controller.wasm'))).digest('hex');
  if (digest.digest('hex') !== manifest.sourceHash || wasmHash !== manifest.wasmHash) throw new Error('Source or binary has changed.');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = checkFirmwareBuild();
    console.log(`Firmware WebAssembly matches production sources (${manifest.sourceHash.slice(0, 12)}).`);
  } catch (error) {
    console.error(`Firmware simulation needs rebuilding: ${error.message}\nRun npm run firmware:build with Zig installed. See firmware/simulation/README.md.`);
    process.exitCode = 1;
  }
}
