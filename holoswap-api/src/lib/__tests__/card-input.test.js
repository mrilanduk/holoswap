const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCardInput } = require('../card-input');

test('"MEP 024" parses as set+number with leading zero stripped', () => {
  assert.deepEqual(parseCardInput('MEP 024'), {
    type: 'set_number', setCode: 'MEP', cardNumber: '24',
  });
});

test('"MEP031" (no space) recognises MEP as a known set code', () => {
  assert.deepEqual(parseCardInput('MEP031'), {
    type: 'set_number', setCode: 'MEP', cardNumber: '31',
  });
});

test('"SV107" (unknown prefix) treated as a card-internal prefixed number', () => {
  assert.deepEqual(parseCardInput('SV107'), {
    type: 'prefixed_number', cardNumber: 'SV107',
  });
});

test('"RC28/RC32" keeps both prefix-numbers when the prefixes match', () => {
  assert.deepEqual(parseCardInput('RC28/RC32'), {
    type: 'prefixed_number', cardNumber: 'RC28', total: 'RC32',
  });
});

test('"4/102" parses as a number-only lookup with denominator', () => {
  assert.deepEqual(parseCardInput('4/102'), {
    type: 'number_only', cardNumber: '4', total: '102',
  });
});

test('"SVI 199/258" parses as set+number with both numerator and denominator', () => {
  assert.deepEqual(parseCardInput('SVI 199/258'), {
    type: 'set_number', setCode: 'SVI', cardNumber: '199',
  });
});

test('"SHF SV107/SV122" combines the inline prefix into the card number', () => {
  assert.deepEqual(parseCardInput('SHF SV107/SV122'), {
    type: 'set_number', setCode: 'SHF', cardNumber: 'SV107',
  });
});

test('Unrecognised free-text falls back to a name_search', () => {
  assert.deepEqual(parseCardInput('charizard'), {
    type: 'name_search', query: 'charizard',
  });
});

test('Whitespace is trimmed before matching', () => {
  assert.deepEqual(parseCardInput('  MEP 024  '), {
    type: 'set_number', setCode: 'MEP', cardNumber: '24',
  });
});

test('Leading-zero-only numerator collapses to "0", not empty', () => {
  assert.deepEqual(parseCardInput('SVI 000'), {
    type: 'set_number', setCode: 'SVI', cardNumber: '0',
  });
});
