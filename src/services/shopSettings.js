const { get, run } = require('../db');
const { DEFAULT_BOARD_PRICE } = require('./cutlistCalculator');

// Shop-level 4ft x 8ft board rate, stored in paisa like every other money column.
async function getBoardPriceTaka() {
  const row = await get('SELECT board_price_paisa FROM shop_settings WHERE id = 1');
  const paisa = row ? Number(row.board_price_paisa) : NaN;
  return Number.isFinite(paisa) && paisa > 0 ? paisa / 100 : DEFAULT_BOARD_PRICE;
}

async function setBoardPriceTaka(taka, adminId) {
  const paisa = Math.round(Number(taka) * 100);
  await run(
    `UPDATE shop_settings
     SET board_price_paisa = ?, updated_by_admin_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = 1`,
    [paisa, adminId || null]
  );
  return paisa / 100;
}

module.exports = { getBoardPriceTaka, setBoardPriceTaka };
