// All money is stored in the database as integer paisa (1 taka = 100 paisa).
// The HTTP API keeps talking in taka so existing clients stay compatible;
// conversion happens only at the database boundary.

const PAISA_PER_TAKA = 100;

// Accept a taka amount from a request/seed value and return integer paisa.
// Returns null for anything that is not a finite, in-range number.
const toPaisa = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) return null;
  const paisa = Math.round(numeric * PAISA_PER_TAKA);
  if (!Number.isSafeInteger(paisa)) return null;
  return paisa;
};

// Integer paisa from the database -> taka number for API responses.
const fromPaisa = (paisa) => {
  const value = Number(paisa);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value) / PAISA_PER_TAKA;
};

// Copy a database row and expose the given money columns in taka.
const takaFields = (row, fields) => {
  if (!row) return row;
  const converted = { ...row };
  for (const field of fields) {
    if (field in converted) converted[field] = fromPaisa(converted[field]);
  }
  return converted;
};

module.exports = {
  PAISA_PER_TAKA,
  toPaisa,
  fromPaisa,
  takaFields
};
