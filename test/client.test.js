'use strict';
// Static checks on the client code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('the client never uses native confirm/alert/prompt (in-app browsers block them)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
    .replace(/\/\/.*$/gm, ''); // ignore comments
  for (const fn of ['confirm', 'alert', 'prompt']) {
    assert.ok(!new RegExp(`(^|[^\\w.])(window\\.)?${fn}\\s*\\(`).test(src), `public/app.js calls ${fn}()`);
  }
});
