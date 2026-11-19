import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The page scripts are not imported by any other test (they need a browser), so a typo in one would only show up as a
// blank page after deploy. Parse every one.
const parses = (source) => spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });

describe('page scripts', () => {
  for (const file of readdirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    it(`${file} parses as a module`, () => {
      const result = parses(readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8'));
      assert.equal(result.status, 0, result.stderr);
    });
  }

  it('the check does fail on a syntax error', () => {
    assert.notEqual(parses("const a = 'broken\n';").status, 0);
  });
});
