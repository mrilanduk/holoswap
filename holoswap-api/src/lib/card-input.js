const { SET_CODE_MAP } = require('./set-codes');

// Parse a price-checker / vending input string into a structured lookup.
// Returns one of:
//   { type: 'set_number', setCode, cardNumber }
//   { type: 'prefixed_number', cardNumber, total? }
//   { type: 'number_only', cardNumber, total }
//   { type: 'name_search', query }
function parseCardInput(input) {
  const trimmed = input.trim();

  // "SV107/SV122" — same letter prefix on both sides means the number itself is prefixed
  const prefixedWithTotal = trimmed.match(/^([A-Za-z]+)\s*(\d+)\s*\/\s*([A-Za-z]+)\s*(\d+)$/);
  if (prefixedWithTotal && prefixedWithTotal[1].toUpperCase() === prefixedWithTotal[3].toUpperCase()) {
    const prefix = prefixedWithTotal[1].toUpperCase();
    return {
      type: 'prefixed_number',
      cardNumber: prefix + prefixedWithTotal[2],
      total: prefix + prefixedWithTotal[4],
    };
  }

  // "MEG 089/123" / "SVI 199/258" / "SHF SV107/SV122"
  const setNumberTotal = trimmed.match(/^([A-Za-z0-9._-]+)\s+([A-Za-z]*)\s*(\d+)\s*\/\s*[A-Za-z]*\s*(\d+)$/);
  if (setNumberTotal) {
    return {
      type: 'set_number',
      setCode: setNumberTotal[1].toUpperCase(),
      cardNumber: (setNumberTotal[2] + setNumberTotal[3]).replace(/^0+/, '') || '0',
    };
  }

  // "MEG 089" / "SHF SV107"
  const setNum = trimmed.match(/^([A-Za-z0-9._-]+)\s+([A-Za-z]*)\s*(\d+)$/);
  if (setNum) {
    return {
      type: 'set_number',
      setCode: setNum[1].toUpperCase(),
      cardNumber: (setNum[2] + setNum[3]).replace(/^0+/, '') || '0',
    };
  }

  // "089/123" — number only
  const numOnly = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (numOnly) {
    return {
      type: 'number_only',
      cardNumber: numOnly[1].replace(/^0+/, '') || '0',
      total: numOnly[2],
    };
  }

  // "MEP031" / "SV107" / "TG15" — alphabetic prefix glued to a number.
  // If the prefix is a known set code, treat as "<SET><NUMBER>"; otherwise treat
  // the whole thing as a card-internal prefixed number.
  const prefixedNum = trimmed.match(/^([A-Za-z]+)\s*(\d+)$/);
  if (prefixedNum) {
    const prefix = prefixedNum[1].toUpperCase();
    const num = prefixedNum[2];
    if (SET_CODE_MAP[prefix]) {
      return {
        type: 'set_number',
        setCode: prefix,
        cardNumber: num.replace(/^0+/, '') || '0',
      };
    }
    return {
      type: 'prefixed_number',
      cardNumber: prefix + num,
    };
  }

  return { type: 'name_search', query: trimmed };
}

module.exports = { parseCardInput };
