const assert = require('node:assert/strict');
const test = require('node:test');

const ui = require('../ui-runtime.js');

test('clipboard failure is returned to the caller', async () => {
  const result = await ui.writeClipboard('value', {
    writeText: async () => {
      throw new Error('denied');
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /denied|复制失败/);
});

test('masked keys are diagnostic only', () => {
  assert.equal(ui.isUsableKey('sk-complete-key-value-123'), true);
  assert.equal(ui.isUsableKey('sk-abcd••••wxyz'), false);
  assert.deepEqual(ui.keyActionsFor('sk-abcd••••wxyz'), {
    canCopy: false,
    canSetDefault: false
  });
});

test('debounce runs only the latest call', async () => {
  const seen = [];
  const debounced = ui.debounce((value) => seen.push(value), 5);
  debounced('first');
  debounced('second');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, ['second']);
});
