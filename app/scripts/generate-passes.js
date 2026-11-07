import QRCode from 'qrcode';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEMO_TOKENS } from '../src/protocol.js';

const destination = new URL('../public/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const [index, token] of DEMO_TOKENS.entries()) {
  const svg = await QRCode.toString(token, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 256 });
  await writeFile(new URL(`demo-pass-${index + 1}.svg`, destination), svg);
}
await writeFile(new URL('demo-passes.html', destination), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Carry · Demo passes</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;color:#173b35;background:#f6f7f2;margin:40px auto;max-width:850px;padding:0 24px}h1{letter-spacing:-1px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}button{background:#164b41;color:white;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}.passes{display:flex;gap:24px;flex-wrap:wrap;margin:30px 0}.pass{border:1px dashed #829080;border-radius:15px;background:white;padding:25px;text-align:center;flex:1;min-width:260px}.pass h2{font-size:22px}.pass img{max-width:100%;width:256px}code{font-size:14px}small,p{line-height:1.7}small{display:block;margin-top:20px;color:#6c7973}@media print{body{background:white;margin:0;max-width:none}.no-print{display:none}.passes{flex-wrap:nowrap}.pass{break-inside:avoid;min-width:0}a{color:inherit}}
</style></head><body><header><div><p>CARRY / TEST KIT</p><h1>Two passes. One reusable tag.</h1></div><button class="no-print" onclick="window.print()">Print passes</button></header><p>Scan pass A to assign and lock. Pass B must be rejected when unlocking that assignment. Unlock with A, then repeat with B to check reuse.</p><div class="passes">${DEMO_TOKENS.map((token, index) => `<article class="pass"><p>SYNTHETIC BOARDING PASS</p><h2>Demo pass ${index ? 'B' : 'A'}</h2><img src="demo-pass-${index + 1}.svg" alt="QR containing ${token}"><p><code>${token}</code></p><small>Demo token only · No passenger information<br>Not valid for travel</small></article>`).join('')}</div><p>For setup: with the bolt open, hold the tag button for ½ second and release. Scan within 10 seconds. Service opening: hold the button for 3 seconds.</p><p class="no-print"><a href="./">← Back to app</a></p></body></html>`);
console.log(`Generated two printable demo passes in ${fileURLToPath(destination)}`);
