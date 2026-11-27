// ============================================================
// SB Furniture & SB POWER — Smart Catalog Discovery Algorithm
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SBCatalogAlgorithm = api;
  }
  if (typeof window !== 'undefined' && window !== root) {
    window.SBCatalogAlgorithm = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_LOOKAHEAD = 10;
  const DEFAULT_SORTS = new Set(['', 'default', 'recommended', 'discovery']);

  /**
   * Generate a non-zero unsigned 32-bit random seed for feed rotation.
   * Uses Web Crypto when available so rapid page loads get distinct lineups.
   * @returns {number} Unsigned 32-bit seed >= 1
   */
  function createDiscoverySeed() {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      if (buf[0] !== 0) return buf[0] >>> 0;
    }
    const fallback = (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
    return fallback || 1;
  }

  /**
   * Compute a deterministic pseudo-random unit float in [0, 1) for a seed and product key.
   * Ensures adjacent database IDs or SKUs produce uncorrelated discovery scores.
   * @param {number} seed
   * @param {string|number} productKey
   * @returns {number}
   */
  function hashProductUnit(seed, productKey) {
    const normalizedSeed = (Number(seed) >>> 0) || 1;
    let hash = (2166136261 ^ normalizedSeed) >>> 0;
    const keyStr = String(productKey || '');
    for (let i = 0; i < keyStr.length; i += 1) {
      hash ^= keyStr.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash = (hash + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Check whether a product carries a custom uploaded storefront image
   * rather than a seeded fallback photo.
   * @param {object} product
   * @returns {boolean}
   */
  function hasCustomCatalogImage(product) {
    const img = String((product && product.image_url) || '').trim();
    return img.includes('/uploads/') || img.startsWith('uploads/');
  }

  /**
   * Extract a normalized leading keyword family from a product title so variants
   * of the same item do not sit consecutively when other items are available.
   * Preserves Unicode combining marks used in Bangla script.
   * @param {object} product
   * @returns {string}
   */
  function extractTitleFamily(product) {
    const raw = String((product && product.title) || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
      .trim();
    if (!raw) {
      return String((product && product.sku) || '').toLowerCase();
    }
    const words = raw.split(/\s+/).filter((w) => w.length > 1);
    return words.slice(0, 2).join(' ') || raw.slice(0, 12);
  }

  /**
   * Normalize text safely for Bangla + English keyword matching.
   * @param {*} value
   * @returns {string}
   */
  function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
  }

  /**
   * Compute deterministic search relevance score for active queries.
   * Keeps exact SKU and title prefix matches at the top above description hits.
   * @param {object} product
   * @param {string} rawQuery
   * @returns {number}
   */
  function computeSearchRelevance(product, rawQuery) {
    const queryText = normalizeText(rawQuery);
    if (!queryText) return 0;

    const tokens = queryText.split(/\s+/).filter(Boolean);
    const sku = normalizeText(product && product.sku);
    const title = normalizeText(product && product.title);
    const category = normalizeText(product && product.category);
    const brand = normalizeText(product && product.brand);
    const meta = [category, brand, normalizeText(product && product.materials), normalizeText(product && product.finish)].join(' ');
    const description = normalizeText(product && product.description);

    let score = 0;
    if (sku === queryText) score += 5000;
    else if (sku.startsWith(queryText)) score += 3200;
    else if (sku.includes(queryText)) score += 1800;

    if (title === queryText) score += 4200;
    else if (title.startsWith(queryText)) score += 2200;
    else if (title.includes(queryText)) score += 1400;

    if (tokens.length > 0 && tokens.every((tok) => title.includes(tok))) {
      score += 1000;
    }

    for (const token of tokens) {
      if (title.includes(token)) score += 160;
      else if (meta.includes(token)) score += 80;
      else if (description.includes(token)) score += 45;
    }

    if (Number((product && product.stock) || 0) > 0) score += 450;
    if (hasCustomCatalogImage(product)) score += 20;
    score += Math.min(30, Number((product && product.id) || 0)) * 0.1;
    return score;
  }

  /**
   * Score an item for per-session discovery: blends seeded freshness jitter
   * with catalog metadata richness and optional category affinity signals.
   * @param {object} product
   * @param {number} seed
   * @param {object} [affinity]
   * @returns {number}
   */
  function scoreDiscoveryCandidate(product, seed, affinity) {
    let qualityBoost = 0;
    if (hasCustomCatalogImage(product)) qualityBoost += 0.12;
    if (String((product && product.description) || '').trim().length >= 25) qualityBoost += 0.07;
    if (String((product && product.materials) || '').trim() || String((product && product.finish) || '').trim()) {
      qualityBoost += 0.04;
    }
    if (Number((product && product.is_featured) || 0) > 0) qualityBoost += 0.09;

    let affinityBoost = 0;
    if (affinity && typeof affinity === 'object') {
      const catCounts = affinity.categories;
      if (catCounts && product && product.category && catCounts[product.category]) {
        affinityBoost += Math.min(0.14, Number(catCounts[product.category]) * 0.05);
      }
      if (Array.isArray(affinity.lastViewedIds) && product && affinity.lastViewedIds[0] === Number(product.id)) {
        // Gentle cooldown on the single item just inspected so fresh siblings lead.
        affinityBoost -= 0.22;
      }
    }

    const stableKey = `${(product && product.id) || ''}:${(product && product.sku) || ''}`;
    const seededJitter = hashProductUnit(seed, stableKey);
    return seededJitter + qualityBoost + affinityBoost;
  }

  /**
   * Interleave scored candidates using a sliding lookahead window so brands,
   * categories, and lookalike product families mix evenly instead of forming
   * monotonous lines.
   * @param {Array<object>} scoredRecords Already sorted descending by score
   * @param {number} [lookahead=10]
   * @returns {Array<object>}
   */
  function interleaveDiverseProducts(scoredRecords, lookahead) {
    if (!Array.isArray(scoredRecords) || scoredRecords.length <= 2) {
      return Array.isArray(scoredRecords) ? scoredRecords.slice() : [];
    }

    const windowSize = Number.isInteger(lookahead) && lookahead >= 2 ? lookahead : DEFAULT_LOOKAHEAD;
    const remaining = scoredRecords.slice();
    const placed = [];

    while (remaining.length > 0) {
      const last1 = placed.length >= 1 ? placed[placed.length - 1] : null;
      const last2 = placed.length >= 2 ? placed[placed.length - 2] : null;
      const scanLimit = Math.min(remaining.length, windowSize);
      let bestIndex = 0;
      let bestAdjusted = -Infinity;

      for (let i = 0; i < scanLimit; i += 1) {
        const candidate = remaining[i];
        let adjusted = candidate.score - i * 0.035;

        if (last1) {
          if (candidate.brand && candidate.brand === last1.brand) {
            adjusted -= last2 && last2.brand === candidate.brand ? 0.72 : 0.45;
          }
          if (candidate.category && candidate.category === last1.category) {
            adjusted -= 0.58;
          }
          if (candidate.family && candidate.family === last1.family) {
            adjusted -= 0.55;
          }
        }
        if (last2) {
          if (candidate.category && candidate.category === last2.category) {
            adjusted -= 0.24;
          }
          if (candidate.family && candidate.family === last2.family) {
            adjusted -= 0.2;
          }
        }

        if (adjusted > bestAdjusted) {
          bestAdjusted = adjusted;
          bestIndex = i;
        }
      }

      placed.push(remaining.splice(bestIndex, 1)[0]);
    }

    return placed;
  }

  /**
   * Compare helper for deterministic explicit sort selections.
   * @param {object} a
   * @param {object} b
   * @param {string} sortMode
   * @returns {number}
   */
  function compareExplicitSort(a, b, sortMode) {
    const idA = Number((a && a.id) || 0);
    const idB = Number((b && b.id) || 0);
    if (sortMode === 'price_asc') {
      return (Number(a.regular_price || 0) - Number(b.regular_price || 0)) || (idA - idB);
    }
    if (sortMode === 'price_desc') {
      return (Number(b.regular_price || 0) - Number(a.regular_price || 0)) || (idB - idA);
    }
    if (sortMode === 'commission_desc') {
      return (Number(b.reseller_commission || 0) - Number(a.reseller_commission || 0)) || (idB - idA);
    }
    if (sortMode === 'newest') {
      return idB - idA;
    }
    return idA - idB;
  }

  /**
   * Rank catalog products cleanly for storefront and API discovery.
   * - Explicit sorts ('price_asc', 'price_desc', 'commission_desc', 'newest', 'id_asc') stay strictly ordered.
   * - Active search queries rank by SKU/title relevance.
   * - Default/discovery browsing partitions in-stock ahead of out-of-stock, scores by per-visit seed + richness
   *   + affinity, and applies brand/category/family diversity interleaving.
   * @param {Array<object>} products
   * @param {object} [options]
   * @returns {Array<object>}
   */
  function rankCatalogProducts(products, options) {
    if (!Array.isArray(products)) return [];
    if (products.length <= 1) return products.slice();

    const opts = options || {};
    const sortMode = String(opts.sort || 'default').trim();
    const searchQuery = String(opts.searchQuery || '').trim();

    if (!DEFAULT_SORTS.has(sortMode)) {
      if (['price_asc', 'price_desc', 'commission_desc', 'newest', 'id_asc'].includes(sortMode)) {
        return products.toSorted((a, b) => compareExplicitSort(a, b, sortMode));
      }
    }

    if (searchQuery) {
      return products
        .slice()
        .map((product) => ({
          product,
          relevance: computeSearchRelevance(product, searchQuery),
          stockFlag: Number((product && product.stock) || 0) > 0 ? 1 : 0,
          id: Number((product && product.id) || 0)
        }))
        .sort((a, b) => (b.relevance - a.relevance) || (b.stockFlag - a.stockFlag) || (b.id - a.id))
        .map((entry) => entry.product);
    }

    const seed = (Number(opts.seed) >>> 0) || createDiscoverySeed();
    const affinity = opts.recentInterests || null;

    const toRecord = (product) => ({
      product,
      id: Number((product && product.id) || 0),
      brand: normalizeText(product && product.brand),
      category: normalizeText(product && product.category),
      family: extractTitleFamily(product),
      score: scoreDiscoveryCandidate(product, seed, affinity)
    });

    const sortDesc = (a, b) => (b.score - a.score) || (a.id - b.id);
    const inStockRecords = [];
    const outOfStockRecords = [];

    for (const product of products) {
      if (Number((product && product.stock) || 0) > 0) {
        inStockRecords.push(toRecord(product));
      } else {
        outOfStockRecords.push(toRecord(product));
      }
    }

    inStockRecords.sort(sortDesc);
    outOfStockRecords.sort(sortDesc);

    const diverseInStock = interleaveDiverseProducts(inStockRecords, opts.lookahead);
    const diverseOutOfStock = interleaveDiverseProducts(outOfStockRecords, opts.lookahead);

    return [...diverseInStock, ...diverseOutOfStock].map((entry) => entry.product);
  }

  return {
    createDiscoverySeed,
    hashProductUnit,
    hasCustomCatalogImage,
    extractTitleFamily,
    computeSearchRelevance,
    scoreDiscoveryCandidate,
    interleaveDiverseProducts,
    rankCatalogProducts
  };
});
