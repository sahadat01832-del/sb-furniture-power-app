// 2D Sheet Math & Cut-list Calculator for 4ft x 8ft (48" x 96") Wooden Boards
// Standard Super S Board / Melamine / Plywood optimization

const BOARD_WIDTH_INCHES = 48; // 4 feet
const BOARD_LENGTH_INCHES = 96; // 8 feet
const BOARD_AREA_SQ_INCHES = BOARD_WIDTH_INCHES * BOARD_LENGTH_INCHES; // 4608 sq inches (32 sq ft)
const DEFAULT_KERF_INCHES = 0.125; // 1/8" saw blade kerf (~3.175mm)
const DEFAULT_WASTAGE_FACTOR = 1.12; // 12% extra for edge trimming & cutting layout loss

/**
 * Calculates total 4ft x 8ft boards needed from a list of parts
 * @param {Array<{name: string, length: number, width: number, qty: number}>} parts
 * @param {Object} options
 * @returns {Object}
 */
function calculateCutlist(parts = [], options = {}) {
  const wastageFactor = Number(options.wastageFactor) || DEFAULT_WASTAGE_FACTOR;
  const boardPrice = Number(options.boardPrice) || 1800; // Average price in Taka

  if (!Array.isArray(parts) || parts.length === 0) {
    return {
      total_boards: 0,
      total_area_sqft: 0,
      efficiency_pct: 0,
      wastage_pct: 0,
      estimated_board_cost: 0,
      parts: []
    };
  }

  let totalAreaSqInches = 0;
  const normalizedParts = parts.map((part, index) => {
    const length = Math.max(0, Number(part.length) || 0);
    const width = Math.max(0, Number(part.width) || 0);
    const qty = Math.max(1, Math.round(Number(part.qty) || 1));
    const partArea = length * width * qty;
    totalAreaSqInches += partArea;

    return {
      id: part.id || `part_${index + 1}`,
      name: String(part.name || `পার্ট #${index + 1}`).trim(),
      length,
      width,
      qty,
      area_sqft: Number(((length * width * qty) / 144).toFixed(2))
    };
  });

  const totalAreaSqFt = Number((totalAreaSqInches / 144).toFixed(2));
  const effectiveAreaNeeded = totalAreaSqInches * wastageFactor;
  const totalBoards = Math.max(1, Math.ceil(effectiveAreaNeeded / BOARD_AREA_SQ_INCHES));

  const totalBoardCapacitySqIn = totalBoards * BOARD_AREA_SQ_INCHES;
  const efficiencyPct = Math.min(100, Math.round((totalAreaSqInches / totalBoardCapacitySqIn) * 100));
  const wastagePct = Math.max(0, 100 - efficiencyPct);
  const estimatedBoardCost = totalBoards * boardPrice;

  return {
    board_specs: {
      width_feet: 4,
      length_feet: 8,
      width_inches: BOARD_WIDTH_INCHES,
      length_inches: BOARD_LENGTH_INCHES,
      sqft_per_board: 32
    },
    total_boards: totalBoards,
    total_area_sqft: totalAreaSqFt,
    efficiency_pct: efficiencyPct,
    wastage_pct: wastagePct,
    estimated_board_cost: estimatedBoardCost,
    parts: normalizedParts
  };
}

/**
 * Generates standard parametric furniture cut-list based on type and dimensions
 * @param {string} type - 'wardrobe', 'table', 'kitchen_cabinet', 'rack', 'bed', 'tv_cabinet'
 * @param {{height: number, width: number, depth: number, thickness: number}} dim
 * @returns {Array<{name: string, length: number, width: number, qty: number}>}
 */
function generateParametricCutlist(type, dim = {}) {
  const h = Math.max(12, Number(dim.height) || 72);
  const w = Math.max(12, Number(dim.width) || 36);
  const d = Math.max(6, Number(dim.depth) || 18);
  const t = Number(dim.thickness) || 0.75; // 18mm board ~ 0.75 inch

  const innerWidth = Number((w - 2 * t).toFixed(2));
  const innerHeight = Number((h - 2 * t).toFixed(2));

  switch (String(type || '').toLowerCase()) {
    case 'table':
    case 'desk':
    case 'study_table':
      return [
        { name: 'টেবিল টপ (Table Top)', length: w, width: d, qty: 1 },
        { name: 'দুই পাশের লেগ/সাইড প্যানেল (Side Legs)', length: Number((h - t).toFixed(2)), width: d, qty: 2 },
        { name: 'পেছনের সাপোর্ট বোর্ড (Back Modesty Panel)', length: innerWidth, width: Number((h * 0.4).toFixed(2)), qty: 1 },
        { name: 'ড্রয়ার সেট ও তাক (Drawer & Shelf Units)', length: Number((d - 2).toFixed(2)), width: Number((innerWidth * 0.4).toFixed(2)), qty: 4 }
      ];

    case 'shelf':
    case 'rack':
    case 'pharmacy_rack':
    case 'book_shelf':
      return [
        { name: 'বাম ও ডান সাইড প্যানেল (Side Panels)', length: h, width: d, qty: 2 },
        { name: 'টপ ও বটম প্যানেল (Top & Bottom)', length: innerWidth, width: d, qty: 2 },
        { name: 'ভেতরের ফিক্সড ও মুভেবল তাক (Shelves)', length: innerWidth, width: Number((d - 1).toFixed(2)), qty: Math.max(3, Math.floor(h / 14)) },
        { name: 'পেছনের ব্যাক পার্ট (Back Panel)', length: h, width: w, qty: 1 }
      ];

    case 'kitchen_cabinet':
    case 'cabinet':
      return [
        { name: 'দুই পাশ (Sides)', length: h, width: d, qty: 2 },
        { name: 'টপ ও বটম (Top & Bottom)', length: innerWidth, width: d, qty: 2 },
        { name: 'মাঝের তাক (Shelves)', length: innerWidth, width: Number((d - 1).toFixed(2)), qty: 2 },
        { name: 'ক্যাবিনেট পাল্লা/দরজা (Doors)', length: Number((h - 1).toFixed(2)), width: Number(((w - 1) / 2).toFixed(2)), qty: 2 },
        { name: 'ব্যাক বোর্ড (Back Panel)', length: h, width: w, qty: 1 }
      ];

    case 'bed':
      return [
        { name: 'হেডবোর্ড (Headboard)', length: w, width: Number((h * 0.6).toFixed(2)), qty: 1 },
        { name: 'ফুটবোর্ড (Footboard)', length: w, width: Number((h * 0.3).toFixed(2)), qty: 1 },
        { name: 'দুই পাশের ফ্রেম (Side Rails)', length: d, width: 12, qty: 2 },
        { name: 'তলার সাপোর্ট শিট (Bed Base Sheets)', length: Number((d - 2).toFixed(2)), width: Number((w - 2).toFixed(2)), qty: 2 }
      ];

    case 'wardrobe':
    case 'almirah':
    default:
      return [
        { name: 'বাম ও ডান সাইড প্যানেল (Left & Right Sides)', length: h, width: d, qty: 2 },
        { name: 'টপ ও বটম প্যানেল (Top & Bottom)', length: innerWidth, width: d, qty: 2 },
        { name: 'মাঝের পার্টেশন/ডিভাইডার (Center Partition)', length: innerHeight, width: Number((d - 1).toFixed(2)), qty: 1 },
        { name: 'অভ্যন্তরীণ তাক (Shelves)', length: Number((innerWidth / 2 - 0.5).toFixed(2)), width: Number((d - 1).toFixed(2)), qty: 4 },
        { name: 'বাইরের পাল্লা/দরজা (Shutters/Doors)', length: Number((h - 1).toFixed(2)), width: Number(((w - 1) / 2).toFixed(2)), qty: 2 },
        { name: 'পেছনের ব্যাক বোর্ড (Back Panel)', length: h, width: w, qty: 1 }
      ];
  }
}

module.exports = {
  BOARD_WIDTH_INCHES,
  BOARD_LENGTH_INCHES,
  BOARD_AREA_SQ_INCHES,
  calculateCutlist,
  generateParametricCutlist
};
