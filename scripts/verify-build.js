'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const inlineScripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1])
  .filter((source) => source.trim());

for (const source of inlineScripts) {
  new vm.Script(source);
}

for (const required of ['schedule-core.js', 'api/calendar.js', 'vercel.json']) {
  if (!fs.existsSync(required)) throw new Error('Missing build input: ' + required);
}

console.log('Build verification passed: ' + inlineScripts.length + ' inline scripts parsed.');
