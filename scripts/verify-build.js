'use strict';

const fs = require('node:fs');
const vm = require('node:vm');

const vercelConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const html = fs.readFileSync('index.html', 'utf8');
const inlineScripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))
  .map((match) => match[1])
  .filter((source) => source.trim());

for (const source of inlineScripts) {
  new vm.Script(source);
}

for (const required of ['index.html', 'schedule-core.js', 'api/calendar.js', 'vercel.json']) {
  if (!fs.existsSync(required)) throw new Error('Missing build input: ' + required);
}

if (vercelConfig.$schema !== 'https://openapi.vercel.sh/vercel.json') {
  throw new Error('Vercel schema must use the official vercel.json schema');
}
if (vercelConfig.buildCommand !== null) {
  throw new Error('Vercel buildCommand must be null for the static root app');
}
if (vercelConfig.outputDirectory !== '.') {
  throw new Error('Vercel outputDirectory must be the repository root');
}

const expectedRewrites = [
  ['/api/calendar', '/api/calendar'],
  ['/calendar.ics', '/api/calendar?action=ics&cal=detail'],
  ['/calendar-simple.ics', '/api/calendar?action=ics&cal=simple'],
];
for (const [source, destination] of expectedRewrites) {
  const preserved = vercelConfig.rewrites?.some(
    (rewrite) => rewrite.source === source && rewrite.destination === destination,
  );
  if (!preserved) throw new Error('Missing Vercel rewrite: ' + source);
}

if (vercelConfig.functions?.['api/calendar.js']?.maxDuration !== 60) {
  throw new Error('Vercel calendar function maxDuration must remain 60 seconds');
}

console.log('Build verification passed: ' + inlineScripts.length + ' inline scripts parsed.');
