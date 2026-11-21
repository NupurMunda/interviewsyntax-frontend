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
    assert.match(page, /removed afterwards by routine cleanup, which runs every 15 minutes and whenever someone signs in/);
    assert.match(page, /Signing out deletes the record for that sign-in on that device, and deleting your account deletes the records for every device/);
    assert.match(page, /Your name and email are not kept in your browser/);
    assert.doesNotMatch(page, /removed when the session ends/);
  });

  it('explains the activity record: what it holds, what it is for, how long it is kept, and that deletion removes it', () => {
    const text = page.replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, "'").replace(/\s+/g, ' ');
    assert.match(text, /activity record/);
    assert.match(text, /how many times you set a question to Done or to Revisit, tracked a company, and opened your dashboard/);
    assert.match(text, /never which questions or companies/);
    assert.match(text, /kept for 13 months/);
    assert.match(text, /combined into daily totals that contain no account numbers/);
    assert.match(text, /your activity record is deleted with it/);
    assert.match(text, /Deleting removes your account, your marks, your tracked companies and your activity record/);
  });

  it('describes the anonymous visit counts as they now work, without promising more than they do', () => {
    const text = page.replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, "'").replace(/\s+/g, ' ');
    assert.match(text, /changes every day, so one day's visits cannot be linked/);
    assert.match(text, /automated, such as search crawlers and monitors, are set aside/);
    assert.match(text, /Do Not Track/);
    assert.doesNotMatch(text, /unchanged/);
  });

  it('describes the browser copy as it behaves: erased on sign-out or deletion, kept when a session just ends', () => {
    const text = page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(text, /The copy is erased when you sign out or delete your account\. If your session ends without you signing out \(for example because it expired\), the copy stays on that device/);
    assert.match(text, /used again only if you sign back in to the same account/);
  });

  it('says deleted data can persist in backups', () => {
    assert.match(page, /deleted data can persist in those backups until they expire/);
  });
});
