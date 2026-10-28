#!/usr/bin/env node
/**
 * Offline pre-submission check: the plugin manifest, the MCP launch config, and consistency between skills and docs.
 * Zero dependencies, node >= 20. Hermes' own loading and approval contract is verified against real Hermes code by
 * tests/test_contract.py.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'tripo';
const HERMES = 'com.nousresearch.hermes';

let failures = 0;
const ok = (msg) => console.log(`  ok  ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const json = (path) => {
  try {
    return JSON.parse(read(path));
  } catch (err) {
    fail(`${path} is not valid JSON: ${err.message}`);
    return {};
  }
};

/** Shipped and documentation files (no dependencies, build caches or binaries). */
function files(dir = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (['.git', 'node_modules', '__pycache__', '.pytest_cache'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (!['.png', '.jpg', '.jpeg', '.webp', '.glb', '.fbx', '.ico'].includes(extname(entry))) out.push(path);
  }
  return out;
}

const manifest = json('plugin.json');
const mcp = json('mcp.json');
const fixture = json('tests/fixtures/tools-list.json');
const hermes = manifest.extensions?.[HERMES] ?? {};
const server = hermes.servers?.[NAME] ?? {};
const launch = mcp.mcpServers?.[NAME] ?? {};
const tools = new Map((fixture.tools ?? []).map((tool) => [tool.name, tool]));

console.log('Names');
check(manifest.name === NAME, `plugin.json name is "${NAME}"`);
check(JSON.stringify(Object.keys(mcp.mcpServers ?? {})) === JSON.stringify([NAME]), `mcp.json has a single server "${NAME}"`);
check(JSON.stringify(Object.keys(hermes.servers ?? {})) === JSON.stringify([NAME]), `the Hermes extension declares only the server "${NAME}"`);
if (existsSync(join(ROOT, 'dashboard/manifest.json'))) {
  check(json('dashboard/manifest.json').name === NAME, `dashboard/manifest.json name is "${NAME}" (otherwise the backend is not mounted)`);
}

console.log('MCP launch');
const pin = (launch.args ?? []).map((arg) => /^tripo-cli@(.+)$/.exec(arg)?.[1]).find(Boolean);
check(launch.command === 'npx' && launch.args?.[0] === '-y', 'launched with npx -y');
check(/^\d+\.\d+\.\d+$/.test(pin ?? ''), `tripo-cli is pinned to an exact version (${pin ?? 'not found'})`);
check(launch.args?.slice(-3).join(' ') === 'mcp --toolset full', 'runs mcp --toolset full');
check(launch.cwd === '${PLUGIN_DATA}', 'cwd is the plugin data directory');
check(launch.env?.TRIPO_API_KEY === '${TRIPO_API_KEY}', 'TRIPO_API_KEY is filled in by Hermes at connect time');
check(launch.env?.TRIPO_HOME?.startsWith('${PLUGIN_DATA}/'), 'TRIPO_HOME is under the plugin data directory');
check(launch.env?.TRIPO_REGION === 'ov', 'international region only (TRIPO_REGION=ov)');
check(launch.env?.TRIPO_ANALYTICS_ENABLED === '0', 'telemetry off by default');
check(fixture.tripo_cli === pin && fixture.toolset === 'full', `the tool snapshot comes from tripo-cli ${fixture.tripo_cli} full (matches the pin)`);

console.log('Approval and billing');
check(server.trust === 'untrusted', 'trust: untrusted (write calls ask first)');
check(server.cost_unit === 'credits', 'cost_unit: credits');
const readOnly = [...tools.values()].filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
check(readOnly.length === 6, `the snapshot has 6 read-only tools (${readOnly.join(', ')})`);
for (const key of Object.keys(server.costs ?? {})) {
  check(tools.has(key) && !readOnly.includes(key), `costs key ${key} is an existing write tool`);
}
if (server.spend_limit !== undefined) check(typeof server.spend_limit === 'number' && server.spend_limit >= 0, 'spend_limit is a non-negative number');
const apiKey = hermes.config_schema?.api_key ?? {};
check(apiKey.type === 'secret' && apiKey.env === 'TRIPO_API_KEY', 'api_key is a secret with the env var TRIPO_API_KEY');

console.log('Versions');
const version = manifest.version;
check(/^\d+\.\d+\.\d+$/.test(version ?? ''), `plugin.json version ${version} is x.y.z`);
check(/^## (\S+)/m.exec(read('CHANGELOG.md'))?.[1] === version, 'the latest CHANGELOG entry matches the plugin.json version');
if (existsSync(join(ROOT, 'package.json'))) check(json('package.json').version === version, 'package.json version matches plugin.json');
if (existsSync(join(ROOT, 'dashboard/manifest.json'))) check(json('dashboard/manifest.json').version === version, 'dashboard/manifest.json version matches plugin.json');

console.log('Skills');
const skills = existsSync(join(ROOT, 'skills')) ? readdirSync(join(ROOT, 'skills')).filter((name) => existsSync(join(ROOT, 'skills', name, 'SKILL.md'))) : [];
check(JSON.stringify(skills.sort()) === JSON.stringify(['tripo-3d', 'tripo-game-asset']), `the skills are tripo-3d and tripo-game-asset (${skills.join(', ')})`);
for (const skill of skills) {
  const text = read(`skills/${skill}/SKILL.md`);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const description = /^description:\s*(.+)$/m.exec(front)?.[1] ?? '';
  check(new RegExp(`^name:\\s*${skill}\\s*$`, 'm').test(front), `${skill}: frontmatter name matches the folder`);
  check(description.length > 0 && description.length <= 1024, `${skill}: description is non-empty and at most 1024 characters`);
  check(text.includes('mcp__tripo__'), `${skill}: names the Hermes tool prefix mcp__tripo__`);
}

console.log('Docs and safety');
const shipped = files();
for (const path of shipped) {
  const rel = relative(ROOT, path);
  const text = readFileSync(path, 'utf8');
  if (rel === 'scripts/validate.mjs') continue;
  // The international result-file CDN happens to sit under tripo3d.com: allow that one host only.
  if (/tripo3d\.com/i.test(text.replaceAll('tripo-data.rg1.data.tripo3d.com', ''))) fail(`${rel} contains tripo3d.com (the plugin is international only)`);
  for (const [label, pattern] of [
    ['a Tripo API key', /\btsk_[A-Za-z0-9_-]{16,}/],
    ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['an AWS key', /\bAKIA[0-9A-Z]{16}\b/],
    ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ]) {
    if (pattern.test(text)) fail(`${rel} appears to contain ${label}`);
  }
  for (const match of text.matchAll(/tripo-cli@(\d+\.\d+\.\d+)/g)) {
    if (match[1] !== pin) fail(`${rel} says tripo-cli@${match[1]}, not the pinned ${pin}`);
  }
  if (/\.md$/.test(rel) || rel === 'plugin.json') {
    for (const match of text.matchAll(/\btripo_[a-z0-9]+(?:_[a-z0-9]+)*\b/g)) {
      if (!tools.has(match[0])) fail(`${rel} mentions ${match[0]}, which is not in the tool snapshot`);
    }
  }
}
check(read('README.md').includes(`tripo-cli@${pin}`) && manifest.description?.includes(`tripo-cli@${pin}`), 'README and the plugin.json description name the pinned tripo-cli version');
ok(`scanned ${shipped.length} files`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
