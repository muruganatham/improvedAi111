const fs = require('fs');
const path = require('path');
const f = require.resolve('@ai-sdk/provider-utils/dist/index.js');
let code = fs.readFileSync(f, 'utf8');
code = code.replace('async function postToApi(args){ console.log("Payload:", JSON.stringify(args.body, null, 2)); return postToApiActual(args); } async function postToApiActual(', 'async function postToApi(');
fs.writeFileSync(f, code);
console.log('Fixed:', f);
