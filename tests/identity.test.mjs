import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION, VERSION_LABEL, APP_CREDIT } from '../src/core/constants.js';
import { createEmptyProject } from '../src/core/project.js';

const root = new URL('..', import.meta.url).pathname;

test('APP_VERSION is a plain semver and package.json follows it', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(VERSION_LABEL, `v${APP_VERSION}`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, APP_VERSION, 'bump package.json together with APP_VERSION in src/core/constants.js');
});

test('creator credit keeps its exact Unicode characters', () => {
  assert.equal(APP_CREDIT, 'Created by .::H∆RBUGΛП::.');
  assert.deepEqual([...'∆ΛП'].map(c => c.codePointAt(0)), [0x2206, 0x039B, 0x041F]);
  assert.ok(APP_CREDIT.includes('H∆RBUGΛП'));
  assert.equal(APP_CREDIT.length, 25);
});

test('no other shipped file hardcodes the release version', () => {
  const files = [];
  const walk = dir => readdirSync(dir).forEach(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (!['legacy', 'node_modules', '.git', 'tests', 'tools', 'docs', '.github'].includes(f)) walk(p); }
    else if (/\.(js|html|json|css)$/.test(f) && f !== 'package.json') files.push(p);
  });
  walk(root);
  const hits = files.filter(p => !p.endsWith(join('src', 'core', 'constants.js')) && readFileSync(p, 'utf8').includes(APP_VERSION));
  assert.deepEqual(hits, []);
});

test('the release identity never goes into saved song data', () => {
  const json = JSON.stringify(createEmptyProject({ name: 'x' }));
  assert.ok(!json.includes(APP_VERSION));
  assert.ok(!json.includes('Created by'));
});
