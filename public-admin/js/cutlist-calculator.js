// 4ft x 8ft (48" x 96") sheet cut-list calculator for Super S board / melamine.
// Shared by the API server (src/services/cutlistCalculator.js) and both admin
// frontends so a board count can never disagree between the product form and
// the board/parts database editor.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SBCutlistCalculator = api;
  }
  if (typeof window !== 'undefined' && window !== root) {
    window.SBCutlistCalculator = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BOARD_WIDTH_INCHES = 48; // 4 feet
  const BOARD_LENGTH_INCHES = 96; // 8 feet
  const BOARD_AREA_SQ_INCHES = BOARD_WIDTH_INCHES * BOARD_LENGTH_INCHES; // 4608 sq inches (32 sq ft)
  const DEFAULT_KERF_INCHES = 0.125; // 1/8" saw blade kerf (~3.175mm)
  const DEFAULT_BOARD_PRICE = 1800;
  const EPSILON = 1e-6;

  const round2 = (value) => Math.round(value * 100) / 100;

  // Longest keywords first: a "কিচেন টেবিল" is a cabinet job, not a table.
  const FURNITURE_TYPE_KEYWORDS = [
    ['kitchen_cabinet', ['kitchen', 'কিচেন', 'ক্যাবিনেট', 'কেবিনেট', 'cabinet']],
    ['bed', ['bed', 'খাট', 'বেড']],
    ['rack', ['shelf', 'শেলফ', 'rack', 'র‍্যাক', 'র্যাক', 'তাক']],
    ['table', ['table', 'টেবিল', 'desk', 'ডেস্ক']]
  ];

  /**
   * Maps a product title / category / free-text type (Bangla or English) onto
   * one of the parametric furniture types. Unknown types are wardrobes, which
   * is also the default the AI prompt and the API use.
   */
  function detectFurnitureType(text) {
    const value = String(text || '').toLowerCase();
    for (const [type, keywords] of FURNITURE_TYPE_KEYWORDS) {
      if (keywords.some((keyword) => value.includes(keyword))) return type;
    }
    return 'wardrobe';
  }

  // A part can come from a single sheet only when its longer side fits along
  // the 96" length and its shorter side fits across the 48" width, allowing
  // the part to be rotated on the board.
  function normalizePart(part, index) {
    const length = Number(part.length);
    const width = Number(part.width);
    const qty = Math.max(1, Math.round(Number(part.qty) || 1));
    if (!Number.isFinite(length) || !Number.isFinite(width) || length <= 0 || width <= 0) return null;

    const long = Math.max(length, width);
    const short = Math.min(length, width);
    return {
      name: String(part.name || `পার্ট #${index + 1}`).trim() || `পার্ট #${index + 1}`,
      length,
      width,
      qty,
      long,
      short,
      area: long * short,
      fits: short <= BOARD_WIDTH_INCHES + EPSILON && long <= BOARD_LENGTH_INCHES + EPSILON
    };
  }

  // Shelf (guillotine) packing: every shelf is one strip of a board, and the
  // blade kerf is reserved between neighbouring pieces on both axes. Returns
  // the number of sheets the given pieces actually need.
  function packBoards(pieces, kerf) {
    const boards = [];
    const sorted = pieces.slice().sort((a, b) => (b.area - a.area) || (b.length - a.length));

    for (const piece of sorted) {
      let placed = false;
      for (const board of boards) {
        for (const shelf of board.shelves) {
          if (piece.width <= shelf.height + EPSILON &&
              shelf.usedLength + kerf + piece.length <= BOARD_LENGTH_INCHES + EPSILON) {
            shelf.usedLength += kerf + piece.length;
            placed = true;
            break;
          }
        }
        if (placed) break;
        if (board.usedWidth + kerf + piece.width <= BOARD_WIDTH_INCHES + EPSILON) {
          board.usedWidth += kerf + piece.width;
          board.shelves.push({ usedLength: piece.length, height: piece.width });
          placed = true;
          break;
        }
      }
      if (!placed) {
        boards.push({ usedWidth: piece.width, shelves: [{ usedLength: piece.length, height: piece.width }] });
      }
    }
    return boards.length;
  }

  /**
   * Calculates how many 4ft x 8ft boards a furniture cut-list needs.
   * @param {Array<{name?: string, length: number, width: number, qty?: number}>} parts
   * @param {{boardPrice?: number, kerf?: number}} [options]
   */
  function calculateCutlist(parts = [], options = {}) {
    const boardPrice = Number(options.boardPrice) > 0 ? Number(options.boardPrice) : DEFAULT_BOARD_PRICE;
    const kerf = options.kerf === undefined || options.kerf === null
      ? DEFAULT_KERF_INCHES
      : Math.max(0, Number(options.kerf) || 0);

    const rows = (Array.isArray(parts) ? parts : [])
      .map((part, index) => normalizePart(part || {}, index))
      .filter(Boolean);

    const pieces = [];
    const warnings = [];
    let areaSqIn = 0;
    let joiningBoards = 0;

    for (const row of rows) {
      areaSqIn += row.area * row.qty;

      if (row.fits) {
        for (let index = 0; index < row.qty; index += 1) {
          pieces.push({ length: row.long, width: row.short, area: row.area });
        }
        continue;
      }

      // Longer/wider than a whole sheet: it has to be joined, so budget the
      // sheets that join actually consumes instead of pretending it fits.
      const boardsNeeded = row.qty * Math.ceil(row.area / BOARD_AREA_SQ_INCHES);
      joiningBoards += boardsNeeded;
      warnings.push(
        `${row.name} (${row.length}″ × ${row.width}″) এক টুকরোয় ৪×৮ বোর্ডে ধরে না — জোড়া লাগাতে ${boardsNeeded} টি বোর্ড হিসাবে ধরা হয়েছে।`
      );
    }

    const totalBoards = packBoards(pieces, kerf) + joiningBoards;
    const efficiencyPct = totalBoards > 0
      ? Math.min(100, Math.round((areaSqIn / (totalBoards * BOARD_AREA_SQ_INCHES)) * 100))
      : 0;

    return {
      board_price: boardPrice,
      total_boards: totalBoards,
      total_area_sqft: round2(areaSqIn / 144),
      efficiency_pct: efficiencyPct,
      wastage_pct: totalBoards > 0 ? 100 - efficiencyPct : 0,
      estimated_board_cost: totalBoards * boardPrice,
      parts: rows.map((row) => ({
        name: row.name,
        length: row.length,
        width: row.width,
        qty: row.qty,
        area_sqft: round2((row.area * row.qty) / 144),
        fits: row.fits
      })),
      warnings
    };
  }

  /**
   * Generates a standard parametric cut-list for a furniture type.
   * @param {string} type - free text: 'wardrobe' / 'টেবিল' / 'বুকশেলফ' / 'খাট' / 'কিচেন কেবিনেট' ...
   * @param {{height: number, width: number, depth: number, thickness: number}} dim
   */
  function generateParametricCutlist(type, dim = {}) {
    const h = Math.max(12, Number(dim.height) || 72);
    const w = Math.max(12, Number(dim.width) || 36);
    const d = Math.max(6, Number(dim.depth) || 18);
    const t = Number(dim.thickness) || 0.75; // 18mm board ~ 0.75 inch

    const innerWidth = Number((w - 2 * t).toFixed(2));
    const innerHeight = Number((h - 2 * t).toFixed(2));

    switch (detectFurnitureType(type)) {
      case 'table':
        return [
          { name: 'টেবিল টপ (Table Top)', length: w, width: d, qty: 1 },
          { name: 'দুই পাশের লেগ/সাইড প্যানেল (Side Legs)', length: Number((h - t).toFixed(2)), width: d, qty: 2 },
          { name: 'পেছনের সাপোর্ট বোর্ড (Back Modesty Panel)', length: innerWidth, width: Number((h * 0.4).toFixed(2)), qty: 1 },
          { name: 'ড্রয়ার সেট ও তাক (Drawer & Shelf Units)', length: Number((d - 2).toFixed(2)), width: Number((innerWidth * 0.4).toFixed(2)), qty: 4 }
        ];

      case 'rack':
        return [
          { name: 'বাম ও ডান সাইড প্যানেল (Side Panels)', length: h, width: d, qty: 2 },
          { name: 'টপ ও বটম প্যানেল (Top & Bottom)', length: innerWidth, width: d, qty: 2 },
          { name: 'ভেতরের ফিক্সড ও মুভেবল তাক (Shelves)', length: innerWidth, width: Number((d - 1).toFixed(2)), qty: Math.max(3, Math.floor(h / 14)) },
          { name: 'পেছনের ব্যাক পার্ট (Back Panel)', length: h, width: w, qty: 1 }
        ];

      case 'kitchen_cabinet':
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

  return {
    BOARD_WIDTH_INCHES,
    BOARD_LENGTH_INCHES,
    BOARD_AREA_SQ_INCHES,
    DEFAULT_KERF_INCHES,
    DEFAULT_BOARD_PRICE,
    detectFurnitureType,
    calculateCutlist,
    generateParametricCutlist
  };
});
