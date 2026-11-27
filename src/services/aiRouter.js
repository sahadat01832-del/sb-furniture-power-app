const { calculateCutlist, generateParametricCutlist } = require('./cutlistCalculator');

// One model call may take up to 15s; the whole failover chain gets a 30s budget.
// Without a total budget, seven candidates × 60s could block an admin for minutes.
const OMNIROUTE_TIMEOUT_MS = Number(process.env.OMNIROUTE_TIMEOUT_MS) || 15000;
const OMNIROUTE_TOTAL_BUDGET_MS = Number(process.env.OMNIROUTE_TOTAL_BUDGET_MS) || 30000;
// A live-but-broken OmniRoute (answers /v1/models, then hangs) would spend the
// whole budget on every run, so tests never resolve a live endpoint at all.
const OMNIROUTE_OFFLINE = process.env.NODE_ENV === 'test' || process.env.OMNIROUTE_OFFLINE === '1';

/**
 * Fetch active PC OmniRoute endpoint from Firestore or environment
 * @returns {Promise<string|null>}
 */
async function discoverPCOmniRouteEndpoint() {
  if (OMNIROUTE_OFFLINE) return null;
  if (process.env.PC_OMNIROUTE_URL) {
    return process.env.PC_OMNIROUTE_URL.replace(/\/+$/, '');
  }

  // Attempt reading from Firestore system_config/omniroute_pc_endpoint if configured
  try {
    const { getAdminFirestore, CONFIG_COLLECTION } = require('../firebaseConnection');
    const db = await getAdminFirestore();
    const doc = await db.collection(CONFIG_COLLECTION || 'system_config').doc('omniroute_pc_endpoint').get();
    if (doc.exists) {
      const data = doc.data();
      if (data && data.endpoint) {
        return String(data.endpoint).replace(/\/+$/, '');
      }
    }
  } catch (err) {
    // Non-fatal if Firestore admin is offline or not configured in this process
  }

  // Fallback to local machine port 20128
  return 'http://127.0.0.1:20128';
}

/**
 * Fetch active Phone OmniRoute endpoint if configured
 * @returns {string|null}
 */
function getPhoneOmniRouteEndpoint() {
  if (OMNIROUTE_OFFLINE) return null;
  if (process.env.PHONE_OMNIROUTE_URL) {
    return process.env.PHONE_OMNIROUTE_URL.replace(/\/+$/, '');
  }
  return null;
}

function extractJsonFromModelContent(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const str = String(raw).trim();
  const match = str.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonStr = match ? match[1].trim() : str;
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(jsonStr.substring(start, end + 1));
    }
    throw err;
  }
}

/**
 * Fast reachability check so unreachable LAN OmniRoute endpoints fail in ~1.2s
 * instead of blocking for 30s across all fallback model retries.
 */
async function probeOmniRoute(endpoint, apiKey, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${endpoint}/v1/models`, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runOmniRouteChain(endpoints, models, messages, deadlineAt, validateResult) {
  for (const target of endpoints) {
    if (!target || !target.url) continue;
    const remainingBeforeProbe = deadlineAt - Date.now();
    if (remainingBeforeProbe < 500) break;

    const reachable = await probeOmniRoute(target.url, target.apiKey, Math.min(1200, remainingBeforeProbe));
    if (!reachable) continue;

    for (const model of models) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < 1000) break;
      try {
        const result = await callChatCompletion(
          target.url,
          target.apiKey,
          model,
          messages,
          Math.min(OMNIROUTE_TIMEOUT_MS, remainingMs)
        );
        if (validateResult(result)) {
          return { result, provider: `${target.label} (${model})` };
        }
      } catch {
        // Try next model candidate
      }
    }
  }
  return null;
}

/**
 * Call an OmniRoute chat endpoint with timeout
 */
async function callChatCompletion(endpoint, apiKey, model, messages, timeoutMs = OMNIROUTE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from model');

    return extractJsonFromModelContent(content);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Multi-Tier OmniRoute Failover Engine for Furniture Woodworking Cutlist:
 * Tier 1: Multilingual Gemini 3.8 models in OmniRoute (antigravity/gemini-3.8-flash-high, auto/gemini)
 * Tier 2: OmniRoute GPT models (auto/gpt, auto/best-reasoning)
 * Tier 3: Phone Server OmniRoute (when PC is offline or unpingable)
 * Tier 4: Zero-Dependency Local Parametric Woodworking Engine
 */
async function estimateFurniturePartsAndBoards({
  furniture_type = 'wardrobe',
  height = 72,
  width = 36,
  depth = 18,
  board_thickness = 0.75,
  board_price = 1800,
  notes = ''
}) {
  const prompt = `
You are an expert master carpenter and furniture structural engineer.
Break down the following custom wooden furniture into its individual cut parts/pieces (BOM - Bill of Materials).

Furniture Type: ${furniture_type}
Dimensions: Height = ${height} inches, Width = ${width} inches, Depth = ${depth} inches.
Board Material: Super S Board / Melamine, Thickness = ${board_thickness} inches.
Notes: ${notes || 'Standard manufacturing with joinery deduction'}

Calculate the exact cutting dimensions (Length in inches, Width in inches, Quantity) for each part.
Account for material thickness deductions at joints (e.g. inner shelves width = total width - 2 * thickness).

Return strictly JSON with this structure:
{
  "parts": [
    { "name": "বাম ও ডান সাইড প্যানেল", "length": 72, "width": 18, "qty": 2 },
    { "name": "টপ ও বটম প্যানেল", "length": 34.5, "width": 18, "qty": 2 }
  ]
}
`.trim();

  const messages = [
    { role: 'system', content: 'You calculate precise woodworking cutting lists. Respond strictly with valid JSON.' },
    { role: 'user', content: prompt }
  ];

  let rawParts = null;
  let providerUsed = 'Offline Parametric Engine';

  const pcEndpoint = await discoverPCOmniRouteEndpoint();
  const phoneEndpoint = getPhoneOmniRouteEndpoint();
  const pcApiKey = process.env.PC_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const phoneApiKey = process.env.PHONE_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const deadlineAt = Date.now() + OMNIROUTE_TOTAL_BUDGET_MS;

  const candidates = [
    process.env.PC_TEXT_MODEL,
    'antigravity/gemini-3.8-flash-high',
    'auto/gemini',
    'auto/gpt',
    'auto'
  ].filter(Boolean);

  const endpoints = [
    pcEndpoint ? { url: pcEndpoint, apiKey: pcApiKey, label: 'OmniRoute' } : null,
    phoneEndpoint && phoneEndpoint !== pcEndpoint ? { url: phoneEndpoint, apiKey: phoneApiKey, label: 'Phone OmniRoute' } : null
  ].filter(Boolean);

  const outcome = await runOmniRouteChain(
    endpoints,
    candidates,
    messages,
    deadlineAt,
    (res) => Boolean(res && Array.isArray(res.parts) && res.parts.length > 0)
  );
  if (outcome) {
    rawParts = outcome.result.parts;
    providerUsed = outcome.provider;
  }

  // Tier 3: Zero-dependency Local Parametric Fallback Engine
  if (!rawParts) {
    rawParts = generateParametricCutlist(furniture_type, {
      height,
      width,
      depth,
      thickness: board_thickness
    });
    providerUsed = 'Phone Local Parametric Engine';
  }

  // Compute final 4ft x 8ft sheet optimization and costs
  const cutlistResult = calculateCutlist(rawParts, { boardPrice: board_price });

  return {
    success: true,
    provider_used: providerUsed,
    furniture_specs: {
      type: furniture_type,
      height,
      width,
      depth,
      thickness: board_thickness
    },
    ...cutlistResult
  };
}

const VALID_CATEGORIES = [
  'হোম ও অফিস ফার্নিচার',
  'দোকান ডেকোরেশন',
  'ওয়্যারলেস অডিও ও গ্যাজেটস',
  'পাওয়ার ব্যাংক ও চার্জার',
  'স্পিকার ও স্মার্ট গ্যাজেট',
  'ওয়াচ ও ফ্যাশন',
  'পাওয়ার টুলস ও ইলেকট্রিক্যাল'
];

function inferBrandFromCategory(category, explicitBrand, isFurniture) {
  if (explicitBrand && ['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(explicitBrand)) {
    return explicitBrand;
  }
  const cat = String(category || '');
  if (isFurniture || cat.includes('ফার্নিচার') || cat.includes('ডেকোরেশন')) return 'SB Furniture';
  if (cat.includes('ওয়াচ') || cat.includes('ফ্যাশন') || cat.includes('টুলস') || cat.includes('ইলেকট্রিক্যাল')) {
    return 'SB Lifestyle & Tools';
  }
  return 'SB POWER';
}

function normalizeAiPricing(retailRaw, wholesaleRaw, commissionRaw, isFurniture) {
  const retail = Math.max(100, Math.round(Number(retailRaw) || (isFurniture ? 6500 : 850)));
  let commission = Math.round(Number(commissionRaw) || 0);
  if (commission <= 0) {
    if (retail < 500) commission = 50;
    else if (retail < 2000) commission = 100;
    else if (retail < 10000) commission = 500;
    else commission = 1000;
  } else if (commission >= 750 && retail >= 5000) commission = 1000;
  else if (commission >= 300 && retail >= 1500) commission = 500;
  else if (commission >= 75 && retail >= 400) commission = 100;
  else commission = 50;

  if (commission >= retail) commission = Math.min(50, Math.max(0, retail - 20));

  let wholesale = Math.round(Number(wholesaleRaw) || Math.max(0, retail - commission - Math.round(retail * 0.15)));
  if (wholesale + commission > retail) {
    wholesale = Math.max(0, retail - commission - Math.round(retail * 0.12));
  }
  return { retail, wholesale, commission };
}

/**
 * Universal Multimodal Vision Inspection:
 * Analyzes ANY product photo (Gadgets, Electronics, Accessories, Furniture, Lifestyle).
 * Generates high-converting Bengali title, captions, detailed descriptions, category, materials, finish,
 * recommended pricing/commission, and if furniture, the complete 4x8 board cutlist.
 *
 * @param {Object} params
 * @param {string} [params.imageBase64]
 * @param {string} [params.mimeType]
 * @param {string} [params.imageUrl]
 * @param {number} [params.boardPrice]
 * @returns {Promise<Object>}
 */
async function inspectProductImageWithAi({ imageBase64, mimeType = 'image/jpeg', imageUrl, boardPrice = 1800 }) {
  let imageSource = null;
  if (imageUrl) {
    imageSource = imageUrl;
  } else if (imageBase64) {
    imageSource = `data:${mimeType};base64,${imageBase64}`;
  }

  if (!imageSource) {
    throw new Error('Image data or URL is required for inspection');
  }

  const promptText = `
You are Bangladesh's #1 eCommerce & D2C copywriting genius and retail merchandiser for 'SB Furniture, SB POWER & SB Lifestyle & Tools' (https://sb-power-marketplace.web.app).
Analyze this product photo with extreme precision and write a world-class, high-converting product listing in natural, persuasive Bangladeshi Bengali (no robotic AI slop, no bland generic phrases like 'আপনার স্টাইল ও ফিটনেসের সেরা সঙ্গী').

Identify what product is depicted and assign the matching brand and category:
- Brand 'SB Furniture' (is_furniture: true): 'হোম ও অফিস ফার্নিচার' or 'দোকান ডেকোরেশন' (Almirah, Wardrobe, Dressing Table, Desk, Stool, Shop Counter, Rack, etc.).
- Brand 'SB POWER' (is_furniture: false): 'ওয়্যারলেস অডিও ও গ্যাজেটস' (Earbuds, Headphones, Neckbands), 'পাওয়ার ব্যাংক ও চার্জার' (Power Banks, Chargers, Cables), or 'স্পিকার ও স্মার্ট গ্যাজেট' (Speakers, Mini Fans, Phone Coolers, Flashlights, Smartwatches).
- Brand 'SB Lifestyle & Tools' (is_furniture: false): 'ওয়াচ ও ফ্যাশন' (Analog Watches, Sunglasses, Wallets) or 'পাওয়ার টুলস ও ইলেকট্রিক্যাল' (Generators, Concrete Drills, Heavy Tools).

Return strictly a single JSON object matching this schema:
{
  "title": "High-converting professional title in Bangla + English + details. Example: প্রিমিয়াম ব্ল্যাক ওয়্যারলেস নেকব্যান্ড ইয়ারফোন (Wireless Neckband) — ম্যাট ব্ল্যাক",
  "brand": "Exactly one of: 'SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'",
  "category": "Exactly one of: 'হোম ও অফিস ফার্নিচার', 'দোকান ডেকোরেশন', 'ওয়্যারলেস অডিও ও গ্যাজেটস', 'পাওয়ার ব্যাংক ও চার্জার', 'স্পিকার ও স্মার্ট গ্যাজেট', 'ওয়াচ ও ফ্যাশন', 'পাওয়ার টুলস ও ইলেকট্রিক্যাল'",
  "is_furniture": true or false,
  "materials": "পণ্যের মূল টেকসই উপাদান বাংলায় (যেমন: প্রিমিয়াম জিঙ্ক অ্যালয় মেটাল বডি ও স্কিন-ফ্রেন্ডলি সিলিকন ওশান স্ট্র্যাপ অথবা সুপার এস ওয়াটারপ্রুফ মেলামাইন বোর্ড, ২ মিমি পিভিসি এজ ব্যান্ডিং ও হাইড্রলিক কব্জা)",
  "finish": "কালার ও ফিনিশ বাংলায় (যেমন: কানাডিয়ান ওক ও স্ক্র্যাচপ্রুফ উড গ্রেইন অথবা ম্যাট ব্ল্যাক ও মেটালিক ফিনিশ)",
  "caption": "High-converting viral Facebook/TikTok/WhatsApp caption. Must follow AIDA formula:\\n- Line 1: Emotional hook / relatable pain point or curiosity with emojis\\n- Line 2: The offer hook with model & price\\n- Lines 3-8: 5-6 bullet benefits with emojis (calls, screen, battery, water resistance, etc.)\\n- Lines 9-10: Offer price vs regular price\\n- Lines 11-13: 🚚 সারাদেশে ক্যাশ অন হোম ডেলিভারি (আগে খুলে চেক করবেন, তারপর টাকা দিবেন!) ও ৭ দিনের রিপ্লেসমেন্ট গ্যারান্টি\\n- Lines 14-16: 📞 কল বা WhatsApp অর্ডার হটলাইন: 01634664224 / 01929621855\\n- Line 17: Viral trending hashtags",
  "description": "Comprehensive Bangladeshi eCommerce listing formatted with clean markdown:\\n## [আকর্ষণীয় হেডলাইন]\\n### 🔍 সংক্ষেপে কী পাচ্ছেন?\\n[২-৩ লাইনের বাস্তবসম্মত ভূমিকা]\\n### ⚡ মূল সুবিধাসমূহ এক নজরে:\\n[৫-৬টি বিস্তারিত বুলেট]\\n### 📋 টেকনিক্যাল স্পেসিফিকেশন:\\n[মডেল, ডিসপ্লে/সাইজ, ম্যাটেরিয়াল, ব্যাটারি/কব্জা, ফিনিশ, সামঞ্জস্যতা]\\n### 📦 বক্সের ভেতরে যা যা পাবেন:\\n[বক্স কনটেন্ট]\\n### 🚚 ডেলিভারি ও ওয়ারেন্টি নিশ্চয়তা:\\n[ক্যাশ অন ডেলিভারি, প্রোডাক্ট চেক সুবিধা, ৭ দিনের রিপ্লেসমেন্ট]",
  "suggested_retail_price": 1250,
  "suggested_wholesale_price": 750,
  "suggested_commission": 150,
  "estimated_dimensions": {
    "height": 72,
    "width": 36,
    "depth": 18
  },
  "parts": [
    { "name": "পার্টসের নাম বাংলায় (যেমন: সাইড প্যানেল)", "length": 72, "width": 18, "qty": 2 }
  ]
}

CRITICAL RULES:
1. If is_furniture is false (gadget/electronics/accessories), set parts to [] and estimated_dimensions to { height: 0, width: 0, depth: 0 }.
2. If is_furniture is true, calculate all structural parts in inches (height, width, qty) for standard 4ft x 8ft board cutting.
3. Pricing: provide realistic Bangladeshi market Taka values for suggested_retail_price, suggested_wholesale_price, and suggested_commission.
4. Output strictly valid JSON. No Markdown ticks, no introductory or trailing text.
`.trim();

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        {
          type: 'image_url',
          image_url: { url: imageSource }
        }
      ]
    }
  ];

  let rawData = null;
  let providerUsed = 'Local Vision Fallback';

  const pcEndpoint = await discoverPCOmniRouteEndpoint();
  const phoneEndpoint = getPhoneOmniRouteEndpoint();
  const pcApiKey = process.env.PC_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const phoneApiKey = process.env.PHONE_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const deadlineAt = Date.now() + OMNIROUTE_TOTAL_BUDGET_MS;

  // Vision model candidates in OmniRoute (Claude Sonnet 4.6, Multilingual Gemini 3.8, Claude Opus, fast fallbacks)
  const visionModels = [
    process.env.PC_VISION_MODEL,
    'antigravity/claude-sonnet-4-6',
    'antigravity/gemini-3.8-flash-high',
    'antigravity/claude-opus-4-6-thinking',
    'auto/gemini',
    'auto/gpt',
    'auto'
  ].filter(Boolean);

  const endpoints = [
    pcEndpoint ? { url: pcEndpoint, apiKey: pcApiKey, label: 'OmniRoute Vision' } : null,
    phoneEndpoint && phoneEndpoint !== pcEndpoint ? { url: phoneEndpoint, apiKey: phoneApiKey, label: 'Phone OmniRoute Vision' } : null
  ].filter(Boolean);

  const outcome = await runOmniRouteChain(
    endpoints,
    visionModels,
    messages,
    deadlineAt,
    (res) => Boolean(res && res.title)
  );
  if (outcome) {
    rawData = outcome.result;
    providerUsed = outcome.provider;
  }

  // Tier 3: Local Smart Fallback
  if (!rawData) {
    rawData = {
      title: 'প্রিমিয়াম স্মার্ট গ্যাজেট (HD Display & Bluetooth Calling) — মেটালিক ব্ল্যাক ফিনিশ',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      is_furniture: false,
      materials: 'উচ্চমানের জিঙ্ক অ্যালয় মেটাল কেসিং এবং প্রিমিয়াম সিলিকন স্ট্র্যাপ',
      finish: 'ম্যাট ব্ল্যাক ও ক্রোম মেটালিক ফিনিশ',
      caption: 'হাতে পরলেই সবাই জানতে চাইবে — "এইটা কত টাকার গ্যাজেট?" 😏⌚\n\nআসলে এইটা প্রিমিয়াম স্মার্ট কালেকশন — আর অফার প্রাইস অবিশ্বাস্য!\n\n✅ সরাসরি ব্লুটুথ কলিং ও লাউড স্পিকার\n✅ উজ্জ্বল ফুল HD স্ক্রিন — কড়া রোদেও একদম পরিষ্কার\n✅ হার্টরেট, রক্তে অক্সিজেন ও ফিটনেস ট্র্যাকার\n✅ দীর্ঘস্থায়ী ব্যাটারি ব্যাকআপ — এক চার্জে দিনভর নিশ্চিন্ত\n\n💰 অফার মূল্য: মাত্র ১,২৫০/- টাকা!\n🚚 সারা দেশে ক্যাশ অন হোম ডেলিভারি — আগে খুলে চেক করবেন, তারপর পেমেন্ট!\n🛡️ ৭ দিনের রিপ্লেসমেন্ট ওয়ারেন্টি গ্যারান্টি।\n📞 কল বা WhatsApp করুন: 01634664224 / 01929621855\n\n#trending #smartwatch #gadgetbangladesh #cashondelivery #sbpower',
      description: '## প্রিমিয়াম স্মার্ট প্রোডাক্ট — আকর্ষণীয় লুক ও আধুনিক ফিচারের সেরা মেলবন্ধন\n\n### 🔍 সংক্ষেপে কী পাচ্ছেন?\nবাজারে এই বাজেটে এত উন্নত বিল্ড কোয়ালিটি ও পারফরম্যান্স পাওয়া সত্যিই বিরল। আধুনিক লাইফস্টাইল ও দৈনন্দিন ব্যবহারের জন্য এটি যেমন দেখতে প্রিমিয়াম, ব্যবহারেও অত্যন্ত স্মুথ। ফোন পকেটে রেখেই কল রিসিভ করুন, মেসেজ নোটিফিকেশন চেক করুন এবং হেলথ ট্র্যাক করুন অনায়াসে।\n\n### ⚡ মূল সুবিধাসমূহ এক নজরে:\n• 📞 সরাসরি ব্লুটুথ কলিং: বিল্ট-ইন লাউড স্পিকার ও মাইক্রোফোন দিয়ে কল ধরুন কোনো ঝামেলা ছাড়াই।\n• 🖥️ উজ্জ্বল ডিসপ্লে: কড়া রোদেও সব নোটিফিকেশন পরিষ্কার দেখা যায়।\n• ❤️ সার্বক্ষণিক হেলথ ট্র্যাকিং: হার্টরেট, স্টেপস, ক্যালোরি ও ঘুমের সঠিক হিসাব কব্জিতেই।\n• 🔋 পাওয়ারফুল ব্যাটারি লাইফ: দীর্ঘস্থায়ী ব্যাটারি ব্যাকআপ যা বারবার চার্জের ঝামেলা কমায়।\n• 🌧️ দৈনন্দিন ওয়াটার রেজিস্ট্যান্ট: ঘাম বা বৃষ্টির হালকা ছিটায় কোনো সমস্যা নেই।\n\n### 📋 টেকনিক্যাল স্পেসিফিকেশন:\n• টাইপ: প্রিমিয়াম স্মার্ট গ্যাজেট\n• মেটেরিয়াল: অ্যালয় কেসিং ও সিলিকন স্ট্র্যাপ\n• সামঞ্জস্যতা: Android ও iOS উভয় ডিভাইসে ১০০% কাজ করে\n\n### 📦 বক্সের ভেতরে যা যা পাবেন:\n• ১x মূল ডিভাইস / প্রোডাক্ট\n• ১x চার্জিং ক্যাবল\n• ১x ইউজার গাইড ও ওয়ারেন্টি স্লিপ\n\n### 🚚 ডেলিভারি ও ওয়ারেন্টি পলিসি:\n• সারাদেশে ক্যাশ অন ডেলিভারি (পণ্য হাতে পেয়ে চেক করে নেওয়ার সুবিধা)।\n• ৭ দিনের অফিসিয়াল রিপ্লেসমেন্ট গ্যারান্টি।',
      suggested_retail_price: 1250,
      suggested_wholesale_price: 750,
      suggested_commission: 150,
      estimated_dimensions: { height: 0, width: 0, depth: 0 },
      parts: []
    };
    providerUsed = 'Built-in Intelligent Template';
  }

  const isFurniture = Boolean(rawData.is_furniture || (rawData.category && (rawData.category.includes('ফার্নিচার') || rawData.category.includes('ডেকোরেশন'))));
  const category = VALID_CATEGORIES.includes(rawData.category)
    ? rawData.category
    : (isFurniture ? 'হোম ও অফিস ফার্নিচার' : 'ওয়্যারলেস অডিও ও গ্যাজেটস');
  const brand = inferBrandFromCategory(category, rawData.brand, isFurniture);
  const pricing = normalizeAiPricing(rawData.suggested_retail_price, rawData.suggested_wholesale_price, rawData.suggested_commission, isFurniture);
  let cutlist = null;

  if (isFurniture && Array.isArray(rawData.parts) && rawData.parts.length > 0) {
    cutlist = calculateCutlist(rawData.parts, { boardPrice });
  }

  return {
    success: true,
    provider_used: providerUsed,
    title: rawData.title || (isFurniture ? 'কাস্টম মেলামাইন ফার্নিচার' : 'প্রিমিয়াম গ্যাজেট ও প্রোডাক্ট'),
    brand,
    category,
    is_furniture: isFurniture,
    materials: rawData.materials || (isFurniture ? 'সুপার এস মেলামাইন বোর্ড' : 'উচ্চমানের পলিমার'),
    finish: rawData.finish || (isFurniture ? 'ন্যাচারাল উড ও মেটালিক ফিনিশ' : 'ম্যাট ব্ল্যাক'),
    caption: rawData.caption || '',
    description: rawData.description || '',
    suggested_retail_price: pricing.retail,
    suggested_wholesale_price: pricing.wholesale,
    suggested_commission: pricing.commission,
    estimated_dimensions: rawData.estimated_dimensions || { height: 0, width: 0, depth: 0 },
    cutlist: cutlist || { parts: [], total_boards: 0, estimated_board_cost: 0 }
  };
}

/**
 * Text & Keyword-based Product Copy & Specs Generator:
 * Takes product name, category, or bullet keywords and generates complete Bengali title,
 * social media caption, rich bulleted description, materials, finish, pricing, and cutlist (if furniture).
 *
 * @param {Object} params
 * @param {string} params.keywords
 * @param {string} [params.category]
 * @param {number} [params.boardPrice]
 * @returns {Promise<Object>}
 */
async function generateProductCopyFromKeywords({ keywords = '', category = '', boardPrice = 1800 }) {
  if (!keywords || !keywords.trim()) {
    throw new Error('Keywords or product title required for AI copy generation');
  }

  const promptText = `
You are Bangladesh's #1 eCommerce & D2C copywriting genius and retail merchandiser for 'SB Furniture, SB POWER & SB Lifestyle & Tools' (https://sb-power-marketplace.web.app).
Based on these product details/keywords: "${keywords.trim()}" (Category Hint: "${category || 'Auto-detect'}").

Generate a complete, world-class, high-converting retail listing in natural, persuasive Bangladeshi Bengali (no robotic AI slop, no bland generic phrases like 'আপনার স্টাইল ও ফিটনেসের সেরা সঙ্গী').
Identify the matching brand ('SB Furniture', 'SB POWER', or 'SB Lifestyle & Tools') and category.

Return strictly JSON matching this schema:
{
  "title": "High-converting professional title in Bangla + English. Example: প্রিমিয়াম ব্লুটুথ স্মার্টওয়াচ (HD Display & Calling) — ব্ল্যাক ফিনিশ",
  "brand": "Exactly one of: 'SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'",
  "category": "Exactly one of: 'হোম ও অফিস ফার্নিচার', 'দোকান ডেকোরেশন', 'ওয়্যারলেস অডিও ও গ্যাজেটস', 'পাওয়ার ব্যাংক ও চার্জার', 'স্পিকার ও স্মার্ট গ্যাজেট', 'ওয়াচ ও ফ্যাশন', 'পাওয়ার টুলস ও ইলেকট্রিক্যাল'",
  "is_furniture": true or false,
  "materials": "পণ্যের মূল টেকসই উপাদান বাংলায় (যেমন: প্রিমিয়াম জিঙ্ক অ্যালয় মেটাল বডি ও সিলিকন ওশান স্ট্র্যাপ অথবা সুপার এস ওয়াটারপ্রুফ মেলামাইন বোর্ড, ২ মিমি পিভিসি এজ ব্যান্ডিং ও হাইড্রলিক কব্জা)",
  "finish": "কালার ও ফিনিশ বাংলায় (যেমন: কানাডিয়ান ওক ও ন্যাচারাল উড গ্রেইন অথবা ম্যাট ব্ল্যাক ও মেটালিক ফিনিশ)",
  "caption": "High-converting viral Facebook/TikTok/WhatsApp caption. Must follow AIDA formula:\\n- Line 1: Emotional hook / relatable pain point or curiosity with emojis\\n- Line 2: The offer hook with model & price\\n- Lines 3-8: 5-6 bullet benefits with emojis (calls, screen, battery, water resistance, etc.)\\n- Lines 9-10: Offer price vs regular price\\n- Lines 11-13: 🚚 সারাদেশে ক্যাশ অন হোম ডেলিভারি (আগে খুলে চেক করবেন, তারপর টাকা দিবেন!) ও ৭ দিনের রিপ্লেসমেন্ট গ্যারান্টি\\n- Lines 14-16: 📞 কল বা WhatsApp অর্ডার হটলাইন: 01634664224 / 01929621855\\n- Line 17: Viral trending hashtags",
  "description": "Comprehensive Bangladeshi eCommerce listing formatted with clean markdown:\\n## [আকর্ষণীয় হেডলাইন]\\n### 🔍 সংক্ষেপে কী পাচ্ছেন?\\n[২-৩ লাইনের বাস্তবসম্মত ভূমিকা]\\n### ⚡ মূল সুবিধাসমূহ এক নজরে:\\n[৫-৬টি বিস্তারিত বুলেট]\\n### 📋 টেকনিক্যাল স্পেসিফিকেশন:\\n[মডেল, ডিসপ্লে/সাইজ, ম্যাটেরিয়াল, ব্যাটারি/কব্জা, ফিনিশ, সামঞ্জস্যতা]\\n### 📦 বক্সের ভেতরে যা যা পাবেন:\\n[বক্স কনটেন্ট]\\n### 🚚 ডেলিভারি ও ওয়ারেন্টি নিশ্চয়তা:\\n[ক্যাশ অন ডেলিভারি, প্রোডাক্ট চেক সুবিধা, ৭ দিনের রিপ্লেসমেন্ট]",
  "suggested_retail_price": 1250,
  "suggested_wholesale_price": 750,
  "suggested_commission": 150,
  "estimated_dimensions": {
    "height": 72,
    "width": 36,
    "depth": 18
  },
  "parts": [
    { "name": "পার্টসের নাম বাংলায়", "length": 72, "width": 18, "qty": 2 }
  ]
}

RULES:
1. If not furniture, parts must be [] and estimated_dimensions { height: 0, width: 0, depth: 0 }.
2. If furniture, generate realistic structural parts (in inches) for standard 4ft x 8ft boards.
3. Realistic Bangladeshi market pricing in Taka.
4. Output strictly raw valid JSON. No markdown ticks, no preamble.
`.trim();

  const messages = [
    { role: 'system', content: 'You are an elite Bangladeshi eCommerce copywriter. Output strictly valid JSON.' },
    { role: 'user', content: promptText }
  ];

  let rawData = null;
  let providerUsed = 'Local Generator';

  const pcEndpoint = await discoverPCOmniRouteEndpoint();
  const phoneEndpoint = getPhoneOmniRouteEndpoint();
  const pcApiKey = process.env.PC_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const phoneApiKey = process.env.PHONE_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || '';
  const deadlineAt = Date.now() + OMNIROUTE_TOTAL_BUDGET_MS;

  const candidates = [
    process.env.PC_TEXT_MODEL,
    'antigravity/claude-sonnet-4-6',
    'antigravity/gemini-3.8-flash-high',
    'antigravity/claude-opus-4-6-thinking',
    'auto/gemini',
    'auto/gpt',
    'auto'
  ].filter(Boolean);

  const endpoints = [
    pcEndpoint ? { url: pcEndpoint, apiKey: pcApiKey, label: 'OmniRoute' } : null,
    phoneEndpoint && phoneEndpoint !== pcEndpoint ? { url: phoneEndpoint, apiKey: phoneApiKey, label: 'Phone OmniRoute' } : null
  ].filter(Boolean);

  const outcome = await runOmniRouteChain(
    endpoints,
    candidates,
    messages,
    deadlineAt,
    (res) => Boolean(res && res.title)
  );
  if (outcome) {
    rawData = outcome.result;
    providerUsed = outcome.provider;
  }

  const isFurniture = Boolean(
    (rawData && rawData.is_furniture) ||
    category.includes('ফার্নিচার') ||
    keywords.includes('ফার্নিচার') ||
    keywords.includes('আলমারি') ||
    keywords.includes('টেবিল') ||
    keywords.includes('খাট') ||
    keywords.includes('ওয়ারড্রব')
  );

  if (!rawData) {
    rawData = {
      title: isFurniture
        ? `SB লাক্সারি ${keywords} (৬×৫ ফিট) — সুপার এস মেলামাইন বোর্ড ও কানাডিয়ান ওক ফিনিশ`
        : `${keywords} (HD Display & Bluetooth Calling) — প্রিমিয়াম ব্ল্যাক মেটালিক ফিনিশ`,
      category: isFurniture ? 'হোম ও অফিস ফার্নিচার' : 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      is_furniture: isFurniture,
      materials: isFurniture
        ? 'সুপার এস প্রিমিয়াম মেলামাইন বোর্ড, ২ মিমি পিভিসি এজ ব্যান্ডিং ও হাইড্রলিক সফট-ক্লোজ কব্জা'
        : 'উচ্চমানের জিঙ্ক অ্যালয় মেটাল কেসিং এবং প্রিমিয়াম স্কিন-ফ্রেন্ডলি সিলিকন স্ট্র্যাপ',
      finish: isFurniture ? 'কানাডিয়ান ওক ও ন্যাচারাল উড গ্রেইন টেক্সচার' : 'ম্যাট ব্ল্যাক ও মেটালিক ক্রোম ফিনিশ',
      caption: isFurniture
        ? `🚨 ঘর বা দোকানের আভিজাত্য বাড়াতে নিয়ে এলো SB Furniture-এর প্রিমিয়াম ${keywords}! 🏡✨\n\n✅ সুপার এস মেলামাইন বোর্ড — পানি ও ঘুণপোকার ভয় নেই\n✅ নিখুঁত ২ মিমি পিভিসি এজ ব্যান্ডিং ও হাইড্রলিক কব্জা\n✅ পর্যাপ্ত স্টোরেজ স্পেস ও নান্দনিক আধুনিক ফিনিশ\n\n💰 শোরুম কোয়ালিটি এখন আকর্ষণীয় অফার মূল্যে!\n🚚 সারাদেশে নিরাপদ হোম ডেলিভারি — আগে পণ্য দেখে বুঝে নিন, তারপর টাকা দিন!\n📞 অর্ডার করতে কল/WhatsApp: 01929621855\n\n#SBFurniture #ModernFurniture #HomeDecor #CashOnDelivery`
        : `হাতে পরলেই সবাই জানতে চাইবে — "এইটা কত টাকার ঘড়ি?" 😏⌚\n\nআসলে এইটা ${keywords} — আর অফার প্রাইস অবিশ্বাস্য!\n\n✅ সরাসরি ব্লুটুথ কলিং ও লাউড স্পিকার\n✅ উজ্জ্বল ফুল HD স্ক্রিন — কড়া রোদেও একদম পরিষ্কার\n✅ হার্টরেট, রক্তে অক্সিজেন ও অল-ডে ফিটনেস ট্র্যাকার\n✅ দীর্ঘস্থায়ী ব্যাটারি ব্যাকআপ — এক চার্জে দিনভর নিশ্চিন্ত\n\n💰 অফার মূল্য: মাত্র ১,২৫০/- টাকা!\n🚚 সারা দেশে ক্যাশ অন হোম ডেলিভারি — আগে খুলে চেক করবেন, তারপর পেমেন্ট!\n🛡️ ৭ দিনের রিপ্লেসমেন্ট ওয়ারেন্টি গ্যারান্টি।\n📞 কল বা WhatsApp করুন: 01634664224 / 01929621855\n\n#trending #smartwatch #gadgetbangladesh #cashondelivery #sbpower`,
      description: isFurniture
        ? `## SB Furniture — আপনার ঘর ও দোকানের জন্য প্রিমিয়াম আসবাব\n\n### 🔍 সংক্ষেপে কী পাচ্ছেন?\nআপনার বাসা বা দোকানের সৌন্দর্য বহুগুণ বাড়িয়ে দিতে SB Furniture নিয়ে এসেছে আধুনিক মেলামাইন ফার্নিচার। মানহীন আসবাবের বদলে দীর্ঘস্থায়ী স্থায়িত্ব, পরিপাটি স্টোরেজ এবং আধুনিক ইউরোপিয়ান লুক নিশ্চিত করতেই এই কালেকশন।\n\n### ⚡ মূল সুবিধাসমূহ এক নজরে:\n• 🪵 সুপার এস মেলামাইন বোর্ড: আন্তর্জাতিক মানের ঘনত্ব ও টেক্সচার, সহজে দাগ বা স্ক্র্যাচ পড়ে না।\n• 🚪 হাইড্রলিক সফট-ক্লোজ কব্জা: দরজা বা পাল্লা জোরে বাড়ি খেয়ে শব্দ হবে না, দীর্ঘ বছর অক্ষত থাকবে।\n• 🛡️ ওয়াটার ও মসচার রেজিস্ট্যান্ট: ২ মিমি পিভিসি এজ ব্যান্ডিং পানি প্রবেশ রোধ করে।\n• 📐 নিখুঁত সাইজ ও পর্যাপ্ত স্পেস: সব ধরণের কাপড়, ফাইল বা মালামাল গুছিয়ে রাখার উপযুক্ত।\n\n### 📋 টেকনিক্যাল স্পেসিফিকেশন:\n• উপাদান: সুপার এস মেলামাইন বোর্ড (১৬/১৮ মিমি)\n• কব্জা: অটো হাইড্রলিক সফট ক্লোজিং কব্জা\n• ফিনিশ: কানাডিয়ান ওক ন্যাচারাল টেক্সচার\n• এজ প্রোটেকশন: ২ মিমি মেশিন পিভিসি এজিং\n\n### 🚚 ডেলিভারি ও সার্ভিস:\n• সারা দেশে নিরাপদ ট্রান্সপোর্ট ডেলিভারি।\n• পণ্য অক্ষত অবস্থায় ডেলিভারির নিশ্চয়তা ও চেক করে পেমেন্ট সুবিধা।`
        : `## ${keywords} — প্রিমিয়াম কোয়ালিটি ও আধুনিক ফিচারের সেরা মেলবন্ধন\n\n### 🔍 সংক্ষেপে কী পাচ্ছেন?\nবাজারে এই বাজেটে এত উন্নত বিল্ড কোয়ালিটি ও পারফরম্যান্স পাওয়া সত্যিই বিরল। আধুনিক লাইফস্টাইল ও দৈনন্দিন ব্যবহারের জন্য এটি যেমন দেখতে আকর্ষণীয়, ব্যবহারেও অত্যন্ত স্মুথ। ফোন পকেটে রেখেই কল রিসিভ করুন, মেসেজ নোটিফিকেশন চেক করুন এবং হেলথ ট্র্যাক করুন অনায়াসে।\n\n### ⚡ মূল সুবিধাসমূহ এক নজরে:\n• 📞 সরাসরি ব্লুটুথ কলিং: বিল্ট-ইন লাউড স্পিকার ও মাইক্রোফোন দিয়ে কল ধরুন কোনো ঝামেলা ছাড়াই।\n• 🖥️ উজ্জ্বল ডিসপ্লে: কড়া রোদেও সব নোটিফিকেশন পরিষ্কার দেখা যায়।\n• ❤️ সার্বক্ষণিক হেলথ ট্র্যাকিং: হার্টরেট, স্টেপস, ক্যালোরি ও ঘুমের সঠিক হিসাব কব্জিতেই।\n• 🔋 পাওয়ারফুল ব্যাটারি লাইফ: দীর্ঘস্থায়ী ব্যাটারি ব্যাকআপ যা বারবার চার্জের ঝামেলা কমায়।\n• 🌧️ ওয়াটার রেজিস্ট্যান্ট বডি: ঘাম বা বৃষ্টির হালকা ছিটায় কোনো সমস্যা নেই।\n\n### 📋 টেকনিক্যাল স্পেসিফিকেশন:\n• বডি: অ্যালয় মেটাল কেসিং ও সিলিকন স্ট্র্যাপ\n• কানেক্টিভিটি: Bluetooth 5.2+\n• সামঞ্জস্যতা: Android ও iOS উভয় ডিভাইসে ১০০% কাজ করে\n\n### 📦 বক্সের ভেতরে যা যা পাবেন:\n• ১x মূল ডিভাইস / প্রোডাক্ট\n• ১x ম্যাগনেটিক চার্জিং কেবল\n• ১x ইউজার গাইড ও ওয়ারেন্টি স্লিপ\n\n### 🚚 ডেলিভারি ও ওয়ারেন্টি পলিসি:\n• সারাদেশে ক্যাশ অন ডেলিভারি (পণ্য হাতে পেয়ে চেক করে নেওয়ার সুবিধা)।\n• ৭ দিনের অফিসিয়াল রিপ্লেসমেন্ট গ্যারান্টি।`,
      suggested_retail_price: isFurniture ? 18500 : 1250,
      suggested_wholesale_price: isFurniture ? 12000 : 750,
      suggested_commission: isFurniture ? 1500 : 150,
      estimated_dimensions: isFurniture ? { height: 72, width: 60, depth: 22 } : { height: 0, width: 0, depth: 0 },
      parts: isFurniture ? generateParametricCutlist('আলমারি', { height: 72, width: 60, depth: 22 }) : []
    };
    providerUsed = 'Intelligent Template Engine';
  }

  let cutlist = null;
  const resolvedCategory = VALID_CATEGORIES.includes(rawData.category)
    ? rawData.category
    : (isFurniture ? 'হোম ও অফিস ফার্নিচার' : 'ওয়্যারলেস অডিও ও গ্যাজেটস');
  const resolvedBrand = inferBrandFromCategory(resolvedCategory, rawData.brand, isFurniture);
  const pricing = normalizeAiPricing(rawData.suggested_retail_price, rawData.suggested_wholesale_price, rawData.suggested_commission, isFurniture);

  if (isFurniture && Array.isArray(rawData.parts) && rawData.parts.length > 0) {
    cutlist = calculateCutlist(rawData.parts, { boardPrice });
  }

  return {
    success: true,
    provider_used: providerUsed,
    title: rawData.title || keywords,
    brand: resolvedBrand,
    category: resolvedCategory,
    is_furniture: isFurniture,
    materials: rawData.materials || (isFurniture ? 'সুপার এস মেলামাইন বোর্ড' : 'উচ্চমানের ম্যাটেরিয়াল'),
    finish: rawData.finish || (isFurniture ? 'ন্যাচারাল উড ফিনিশ' : 'ম্যাট ফিনিশ'),
    caption: rawData.caption || '',
    description: rawData.description || '',
    suggested_retail_price: pricing.retail,
    suggested_wholesale_price: pricing.wholesale,
    suggested_commission: pricing.commission,
    estimated_dimensions: rawData.estimated_dimensions || { height: 0, width: 0, depth: 0 },
    cutlist: cutlist || { parts: [], total_boards: 0, estimated_board_cost: 0 }
  };
}

/**
 * Generate 3-in-1 Multi-Channel Marketing Copy for any product
 * 1. Facebook & WhatsApp sales pitch
 * 2. TikTok / Reels short video hook & script
 * 3. Reseller promotion pitch
 *
 * @param {Object} product
 * @param {string} [originUrl]
 * @returns {Object}
 */
function generateMultiChannelMarketingCopy(product, originUrl = 'https://sb-power-marketplace.web.app') {
  if (!product) return null;

  const isFurniture = product.brand === 'SB Furniture' || (product.category && product.category.includes('ফার্নিচার'));
  const hotline = isFurniture ? '01929621855' : '01634664224';
  const link = `${originUrl}/?sku=${encodeURIComponent(product.sku || '')}`;

  // 1. Facebook & WhatsApp Sales Pitch
  let fbPost = `🔥 ${product.title}\n`;
  fbPost += `━━━━━━━━━━━━━━━━━━━━━\n`;
  const regularStrike = Math.round(product.regular_price * 1.3);
  fbPost += `🏷️ রেগুলার প্রাইস: ${regularStrike} ৳ | 💥 অফার প্রাইস: মাত্র ${product.regular_price} ৳\n`;
  if (product.reseller_commission > 0) {
    fbPost += `💰 রিসেলার কমিশন: প্রতি পিসে ${product.reseller_commission} ৳ নিশ্চিত প্রফিট!\n`;
  }
  if (product.materials) fbPost += `💎 প্রিমিয়াম উপাদান: ${product.materials}\n`;
  if (product.finish) fbPost += `🎨 কালার ও ফিনিশ: ${product.finish}\n`;
  fbPost += `📦 স্টক স্ট্যাটাস: ${product.stock || 10} টি এভেইলেবল (সীমিত স্টক)\n`;
  fbPost += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (product.caption) {
    fbPost += `${product.caption}\n\n`;
  }
  if (product.description) {
    fbPost += `📌 বিস্তারিত স্পেসিফিকেশন ও বিবরণ:\n${product.description}\n\n`;
  }
  fbPost += `🚚 সারা দেশে দ্রুততম ক্যাশ অন হোম ডেলিভারি (আগে খুলে চেক করে নিবেন, তারপর পেমেন্ট!)\n`;
  fbPost += `🛒 অনলাইন অর্ডার লিংক: ${link}\n`;
  fbPost += `📞 সরাসরি কল বা WhatsApp অর্ডার: ${hotline}`;

  // 2. TikTok / Instagram Reels Short Video Script
  let tiktokScript = `🎬 [শর্ট ভিডিও স্ক্রিপ্ট — ১৫ থেকে ৩০ সেকেন্ড]\n\n`;
  tiktokScript += `[ভিজ্যুয়াল হুক (০-৩ সে.)]: পণ্যের ক্লোজ-আপ প্রিমিয়াম শট ও চোখ ধাঁধানো ফিনিশ দেখান। হাত দিয়ে স্পর্শ করে কোয়ালিটি ফিল করান।\n`;
  tiktokScript += `[ভয়েসওভার]: "বাজারে এত চড়া দামের মধ্যে এই কোয়ালিটি কীভাবে সম্ভব? দেখুন ${product.title}!"\n\n`;
  tiktokScript += `[ফিচার শোকেস (৩-১২ সে.)]: এর আসল আকর্ষণ — ${product.materials || 'প্রিমিয়াম বিল্ড কোয়ালিটি'} এবং ${product.finish || 'নান্দনিক ডিজাইন'}। ব্যবহারের অভিজ্ঞতা দেখান কতটা প্রিমিয়াম ও স্মুথ!\n\n`;
  tiktokScript += `[অফার ও কল-টু-অ্যাকশন (১২-২০ সে.)]: আর দাম? একদম কল্পনাতীত — মাত্র ${product.regular_price} টাকা! সাথে পাচ্ছেন সারা দেশে ক্যাশ অন ডেলিভারি। আগে হাতে পেয়ে চেক করবেন, তারপর টাকা দিবেন!\n\n`;
  tiktokScript += `[সমাপ্তি (২০-২৫ সে.)]: স্টক খুব সীমিত! অর্ডার করতে এখনই স্ক্রিনে দেখানো নম্বরে বা বায়োতে দেওয়া লিংকে ক্লিক করুন!\n`;
  tiktokScript += `[হ্যাশট্যাগ]: #SBFurniture #SBPower #${encodeURIComponent((product.category || 'gadget').replace(/\s+/g, ''))} #trending #bangladesh #foryou #foryoupage #viralbd`;

  // 3. Reseller Pitch (উপার্জন ও প্রমোশন টিপস)
  let resellerPitch = `💼 [রিসেলারদের জন্য স্পেশাল প্রমোশন ও সেলস গাইড]\n\n`;
  resellerPitch += `📦 পণ্য: ${product.title}\n`;
  resellerPitch += `💰 প্রতি পিসে আপনার নিশ্চিত লাভ: ${product.reseller_commission || 100} ৳!\n`;
  resellerPitch += `🎯 টার্গেট কাস্টমার: ${isFurniture ? 'নতুন বাড়ি/ফ্ল্যাট সাজানো পরিবার, শোরুম ও অফিস মালিক' : 'তরুণ-তরুণী, ছাত্র-ছাত্রী, বাইকার ও অনলাইন শপার'}\n\n`;
  resellerPitch += `💡 বিক্রির সিক্রেট টিপস:\n`;
  resellerPitch += `১. ফেসবুক মার্কেটপ্লেস ও বিভিন্ন বাই-সেল গ্রুপে আমাদের দেয়া আকর্ষণীয় ক্যাপশন ও ছবি দিয়ে পোস্ট করুন।\n`;
  resellerPitch += `২. কাস্টমারকে জোর দিয়ে বলুন: "আগে পণ্য হাতে পেয়ে খুলে চেক করবেন, পছন্দ হলে তারপর ডেলিভারিম্যানকে টাকা দিবেন!" — এই এক লাইনেই আপনার সেলস দ্বিগুণ হয়ে যাবে।\n`;
  resellerPitch += `৩. কাস্টমার ঠিকানা ও মোবাইল দিলে সরাসরি আপনার রিসেলার প্যানেলে অর্ডার প্লেস করুন। প্যাকিং, ডেলিভারি ও কালেকশন সব আমরা করব — ডেলিভারি হওয়া মাত্র আপনার ওয়ালেটে কমিশন যোগ হবে!`;

  return {
    facebook_whatsapp: fbPost,
    tiktok_reels: tiktokScript,
    reseller_pitch: resellerPitch
  };
}

module.exports = {
  discoverPCOmniRouteEndpoint,
  estimateFurniturePartsAndBoards,
  inspectProductImageWithAi,
  generateProductCopyFromKeywords,
  generateMultiChannelMarketingCopy
};
