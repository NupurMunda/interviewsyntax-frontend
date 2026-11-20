import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const page = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');

// Sign-in must stay off until the owner supplies a real contact address (operator-assisted deletion depends on it).
// This test documents the current state: a clearly marked placeholder and no address of any kind. When the owner provides
// the address, replace the placeholder, delete the first test and add one that checks the address is present.
describe('privacy page contact address', () => {
  it('has a clearly marked placeholder, and the page is not ready for sign-in to be switched on', () => {
    assert.match(page, /data-contact-placeholder>\[PLACEHOLDER:/);
  });

  it('contains no invented email address or mailto link', () => {
    assert.doesNotMatch(page, /mailto:/i);
    assert.doesNotMatch(page, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+.[A-Za-z]{2,}/);
  });

  it('states the actual session record lifecycle rather than promising prompt removal', () => {
    assert.match(page, /removed later by routine cleanup/);
    assert.doesNotMatch(page, /removed when the session ends/);
  });

  it('says deleted data can persist in backups', () => {
    assert.match(page, /deleted data can persist in those backups until they expire/);
  });
});
