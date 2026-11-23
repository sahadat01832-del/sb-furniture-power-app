const { initDb, query, run, get } = require('./db');
const { hashPassword } = require('./auth');
const config = require('./config');

const seedData = async ({ includeDemoProducts = false } = {}) => {
  console.log('--- Initializing Database & Seeding Data ---');
  await initDb();

  // 1. Seed Admin User
  const existingAdmin = config.ADMIN.phone
    ? await get('SELECT * FROM users WHERE phone = ?', [config.ADMIN.phone])
    : null;
  if (!config.ADMIN.phone || !config.ADMIN.password) {
    console.log('Admin setup skipped. Configure ADMIN_PHONE and ADMIN_PASSWORD to create the first admin account.');
  } else if (!existingAdmin) {
    const passwordHash = await hashPassword(config.ADMIN.password);
    await run(
      `INSERT INTO users (name, phone, password_hash, role, referral_code) 
       VALUES (?, ?, ?, 'admin', 'ADMIN01')`,
      [config.ADMIN.name, config.ADMIN.phone, passwordHash]
    );
    console.log(`Created default Admin account: ${config.ADMIN.phone}`);
  }

  // 2. Check if products already exist
  if (!includeDemoProducts) {
    console.log('Demo catalog seed skipped. Add real products from the admin panel.');
    return;
  }

  const countRow = await get('SELECT COUNT(*) as count FROM products');
  if (countRow.count > 0) {
    console.log(`Database already has ${countRow.count} products. Preserving the existing catalog.`);
    return;
  }

  const products = [
    // ==========================================
    // SECTION A: SHOP DECORATION (দোকান ডেকোরেশন)
    // SBF-101 to SBF-110
    // ==========================================
    {
      title: 'আধুনিক ফার্মেসি ডেকোরেশন ও গ্লাস কাউন্টার (Pharmacy Rack & Counter) — Code: SBF-101',
      sku: 'SBF-101',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 18500,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1576602976047-174e57a47881?auto=format&fit=crop&w=800&q=80',
      description: 'ফার্মেসির জন্য আধুনিক ঔষধ ডিসপ্লে র্যাক এবং ড্রয়ার সহ নিরাপদ টেম্পারড গ্লাস কাউন্টার। মেডিসিন সাজাতে পর্যাপ্ত কম্পার্টমেন্ট ও লকিং সুবিধা।',
      materials: 'সুপার এস বোর্ড (Super S Board) ও মেলামাইন বোর্ড (Melamine Board)',
      finish: 'White Carrara Marble (ব্ল্যাক এজ ব্যান্ডিংসহ)',
      stock: 50
    },
    {
      title: 'প্রিমিয়াম মোবাইল শোরুম ডিসপ্লে র্যাক ও ক্যাবিনেট (Mobile Showroom Display Rack) — Code: SBF-102',
      sku: 'SBF-102',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 22000,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=800&q=80',
      description: 'স্মার্টফোন ও গ্যাজেট শোরুমের জন্য চোখ ধাঁধানো এলইডি ব্যাকলিট সহ স্লিম গ্লাস শেলফ ও নিচের সিকিউর স্টোরেজ ক্যাবিনেট।',
      materials: 'রম বোর্ড (ROM Board) ও সুপার এস বোর্ড',
      finish: 'Black & Gold Marble',
      stock: 45
    },
    {
      title: 'কসমেটিকস শপ ডিসপ্লে সেলফ ও ড্রয়ার কাউন্টার (Cosmetics Shop Display Shelf) — Code: SBF-103',
      sku: 'SBF-103',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 14500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=800&q=80',
      description: 'বিউটি ও কসমেটিকস সামগ্রী সাজানোর জন্য বহুস্তরী ডিসপ্লে র্যাক। সাথে মেকআপ ট্রায়াল মিরর যুক্ত করার উপযুক্ত কাঠামো।',
      materials: 'মেলামাইন বোর্ড (Melamine Board)',
      finish: 'White Carrara Marble (ব্ল্যাক এজ ব্যান্ডিংসহ)',
      stock: 60
    },
    {
      title: 'সুপার শপ ও গ্রোসারি গন্ডোলা র্যাক (Grocery & Super Shop Rack) — Code: SBF-104',
      sku: 'SBF-104',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 12000,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?auto=format&fit=crop&w=800&q=80',
      description: 'মুদি বা সুপার শপের মালামাল সুশৃঙ্খলভাবে রাখার জন্য হেভি ডিউটি মজবুত শেলফ। সহজে ধোয়া ও মোছার উপযোগী মসৃণ বোর্ড।',
      materials: 'সুপার এস বোর্ড (Super S Board)',
      finish: 'Golden Burma Teak',
      stock: 80
    },
    {
      title: 'ইলেকট্রিক্যাল ও হার্ডওয়্যার শপ ক্যাবিনেট (Electrical Shop Cabinet) — Code: SBF-105',
      sku: 'SBF-105',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 16500,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1581783342308-f792dbdd27c5?auto=format&fit=crop&w=800&q=80',
      description: 'ভারী হার্ডওয়্যার আইটেম, বৈদ্যুতিক যন্ত্রপাতি ও ক্যাবল সাজানোর উপযোগী মজবুত ড্রয়ার ও গভীর তাক বিশিষ্ট ক্যাবিনেট।',
      materials: 'রম বোর্ড (ROM Board) ও সুপার এস বোর্ড',
      finish: 'Dark Walnut Fluted Stripe',
      stock: 40
    },
    {
      title: 'আধুনিক বুটিক ও কাপড়ের শোরুম ওয়াল র্যাক (Boutique Wall Rack Unit) — Code: SBF-106',
      sku: 'SBF-106',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 13500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=800&q=80',
      description: 'গার্মেন্টস ও বুটিক শপের জন্য ক্লথ হ্যাঙ্গিং স্পেস ও ভাঁজ করা কাপড় রাখার নান্দনিক খোলা শেলফ সিস্টেম।',
      materials: 'মেলামাইন বোর্ড (Melamine Board)',
      finish: 'Classic Cherry Teak',
      stock: 55
    },
    {
      title: 'ক্যাশ কাউন্টার ও রিসেপশন ডেস্ক টেবিল (Store Cashier Counter Desk) — Code: SBF-107',
      sku: 'SBF-107',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 8500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=800&q=80',
      description: 'যেকোনো দোকানের জন্য কম্প্যাক্ট ক্যাশ ড্রয়ার, কম্পিউটার মনিটর স্পেস ও ক্যাবল ম্যানেজমেন্ট সুবিধা সহ ক্যাশ কাউন্টার।',
      materials: 'সুপার এস বোর্ড (Super S Board)',
      finish: 'Black & Gold Marble',
      stock: 70
    },
    {
      title: 'চশমার দোকান ও অপটিক্যাল ডিসপ্লে শোকেস (Optical Display Showcase) — Code: SBF-108',
      sku: 'SBF-108',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 19500,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=800&q=80',
      description: 'আইওয়্যার ফ্রেম ও সানগ্লাস সাজানোর জন্য লক সিস্টেম গ্লাস ফ্রন্ট এবং ভেতরের নরম আলো প্রতিফলন উপযোগী মার্বেল ফিনিশ।',
      materials: 'রম বোর্ড (ROM Board)',
      finish: 'White Carrara Marble (ব্ল্যাক এজ ব্যান্ডিংসহ)',
      stock: 35
    },
    {
      title: 'জুতার শোরুম ডিসপ্লে ওয়াল র্যাক (Footwear Showroom Wall Rack) — Code: SBF-109',
      sku: 'SBF-109',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 11500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=800&q=80',
      description: 'বিভিন্ন সাইজের জুতা ও স্যান্ডেল ডিসপ্লে করার জন্য মাল্টি-টায়ার স্ল্যান্টেড ও ফ্ল্যাট তাক সমৃদ্ধ দোকান র্যাক।',
      materials: 'মেলামাইন বোর্ড (Melamine Board)',
      finish: 'Golden Burma Teak',
      stock: 65
    },
    {
      title: 'ডিপার্টমেন্টাল স্টোর আইল্যান্ড সেন্টার র্যাক (Store Center Island Rack) — Code: SBF-110',
      sku: 'SBF-110',
      brand: 'SB Furniture',
      category: 'দোকান ডেকোরেশন',
      regular_price: 9500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1534452203293-494d7ddbf7e0?auto=format&fit=crop&w=800&q=80',
      description: 'দোকানের মাঝখানে রাখার মতো দুই পাশে তাক বিশিষ্ট মিডল আইল্যান্ড র্যাক, যা ক্রেতাদের হাঁটাচলা ও পণ্য দেখতে সহজ করে।',
      materials: 'সুপার এস বোর্ড (Super S Board)',
      finish: 'Dark Walnut Fluted Stripe',
      stock: 75
    },

    // ==========================================
    // SECTION B: HOME & OFFICE FURNITURE (হোম ও অফিস ফার্নিচার)
    // SBF-201 to SBF-210
    // ==========================================
    {
      title: '৪ পাল্লা মেলামাইন বোর্ড আধুনিক আলমারি (4-Door Modern Almirah) — Code: SBF-201',
      sku: 'SBF-201',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 24500,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1595428774223-ef52624120d2?auto=format&fit=crop&w=800&q=80',
      description: 'বিশাল সাইজের ৪ পাল্লার আলমারি। কাপড় ঝুলানোর হ্যাঙ্গার স্পেস, গোপন লকার ড্রয়ার এবং দীর্ঘস্থায়ী প্রিমিয়াম কব্জা সহ তৈরি।',
      materials: 'রম বোর্ড (ROM Board) ও সুপার এস বোর্ড',
      finish: 'Golden Burma Teak',
      stock: 30
    },
    {
      title: '৩ ড্রয়ার ও ২ পাল্লা বিলাসবহুল ওয়ারড্রোব (Luxury 3-Drawer Wardrobe) — Code: SBF-202',
      sku: 'SBF-202',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 17500,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1558997519-83ea9252edf8?auto=format&fit=crop&w=800&q=80',
      description: 'স্মুথ স্লাইড ড্রয়ার ও পাশে হ্যাঙ্গিং স্পেস সহ কমপ্যাক্ট কিন্তু বিশাল ধারণক্ষমতার আধুনিক মাস্টার বেডরুম ওয়ারড্রোব।',
      materials: 'মেলামাইন বোর্ড (Melamine Board)',
      finish: 'White Carrara Marble (ব্ল্যাক এজ ব্যান্ডিংসহ)',
      stock: 40
    },
    {
      title: 'ফুল মিরর এলিগ্যান্ট ড্রেসিং টেবিল (Full Mirror Elegant Dressing Table) — Code: SBF-203',
      sku: 'SBF-203',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 9500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1534349762230-e0cadf78f5da?auto=format&fit=crop&w=800&q=80',
      description: 'ক্রিস্টাল ক্লিয়ার পূর্ণাঙ্গ আয়না, প্রসাধন সামগ্রী রাখার পর্যাপ্ত লুকানো সেলফ ও ড্রয়ার সহ চোখ জুড়ানো ড্রেসিং টেবিল।',
      materials: 'সুপার এস বোর্ড (Super S Board)',
      finish: 'Black & Gold Marble',
      stock: 50
    },
    {
      title: 'আধুনিক মার্বেল ফিনিশ টিভি ক্যাবিনেট (Marble Finish Modern TV Cabinet) — Code: SBF-204',
      sku: 'SBF-204',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 11000,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=800&q=80',
      description: '৫৫ ইঞ্চি পর্যন্ত স্মার্ট টিভির জন্য উপযোগী। সেট-টপ বক্স, সাউন্ডবার ও ডেকোরেশন সামগ্রী সাজানোর ড্রয়ার সহ আধুনিক ডিজাইন।',
      materials: 'রম বোর্ড (ROM Board)',
      finish: 'White Carrara Marble (ব্ল্যাক এজ ব্যান্ডিংসহ)',
      stock: 45
    },
    {
      title: 'এক্সিকিউটিভ অফিস ডেস্ক ও ড্রয়ার ইউনিট (Executive Office Desk Unit) — Code: SBF-205',
      sku: 'SBF-205',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 12500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?auto=format&fit=crop&w=800&q=80',
      description: 'ম্যানেজার ও এক্সিকিউটিভদের জন্য প্রশস্থ টপ টেবিল, ফাইল রাখার ৩টি সিকিউর লকিং ড্রয়ার এবং অ্যান্টি-স্ক্র্যাচ ফিনিশিং।',
      materials: 'সুপার এস বোর্ড (Super S Board)',
      finish: 'Dark Walnut Fluted Stripe',
      stock: 35
    },
    {
      title: '৬ সিটার প্রিমিয়াম ডাইনিং টেবিল ও চেয়ার সেট (6-Seater Premium Dining Table) — Code: SBF-206',
      sku: 'SBF-206',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 32000,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?auto=format&fit=crop&w=800&q=80',
      description: 'পরিবারের খাবার সময়ের আভিজাত্য বাড়াতে মার্বেল টেক্সচার টপ ডাইনিং টেবিল ও ৬টি আরামদায়ক হাই-ব্যাক চেয়ার।',
      materials: 'রম বোর্ড (ROM Board) ও সলিড উড স্ট্রাকচার',
      finish: 'Classic Cherry Teak',
      stock: 20
    },
    {
      title: 'গ্লাস ডোর লিভিং রুম শোকেস (Glass Door Living Room Showcase) — Code: SBF-207',
      sku: 'SBF-207',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 18000,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1594026112284-02bb6f3352fe?auto=format&fit=crop&w=800&q=80',
      description: 'ক্রোকারিজ সামগ্রী ও পুরস্কার সাজানোর আকর্ষণীয় কাঁচের পাল্লা দেওয়া লিভিং রুম ড্রয়িং শোকেস ক্যাবিনেট।',
      materials: 'সুপার এস বোর্ড (Super S Board)',
      finish: 'Golden Burma Teak',
      stock: 25
    },
    {
      title: 'মডার্ন কিচেন ওয়াল ও বেস ক্যাবিনেট (Modern Kitchen Cabinet Set) — Code: SBF-208',
      sku: 'SBF-208',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 26000,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80',
      description: 'রান্নাঘরের তৈজসপত্র সাজাতে ওয়াটার-রেজিস্ট্যান্ট বোর্ডের আধুনিক কিচেন ক্যাবিনেট সেট (দেয়াল ও মেঝে দুই অংশ)।',
      materials: 'রম বোর্ড (ROM Board) - ওয়াটার প্রুফ কোটেড',
      finish: 'White Carrara Marble (ব্ল্যাক এজ ব্যান্ডিংসহ)',
      stock: 20
    },
    {
      title: 'মার্বেল টপ লাক্সারি টি-টেবিল (Marble Top Luxury Center Tea Table) — Code: SBF-209',
      sku: 'SBF-209',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 6500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1533090161767-e6ffed986c88?auto=format&fit=crop&w=800&q=80',
      description: 'সোফার সামনে ড্রয়িং রুমের সৌন্দর্য বাড়াতে প্রিমিয়াম মার্বেল ফিনিশ গোল বা চারকোনা আধুনিক কফি/টি-টেবিল।',
      materials: 'মেলামাইন বোর্ড (Melamine Board)',
      finish: 'Black & Gold Marble',
      stock: 60
    },
    {
      title: 'এল-শেপ এরগনোমিক অফিস ও স্টাডি টেবিল (L-Shape Corner Study Table) — Code: SBF-210',
      sku: 'SBF-210',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 10500,
      reseller_commission: 500,
      commission_tab: '500tk',
      image_url: 'https://images.unsplash.com/photo-1505330622279-bf7d7fc918f4?auto=format&fit=crop&w=800&q=80',
      description: 'ঘরে বসে কাজ বা পড়াশোনার জন্য কোণায় ফিট হওয়া এল-শেপ আধুনিক টেবিল। বুকশেলফ ও পিসি রাখার আলাদা জায়গা।',
      materials: 'সুপার এস বোর্ড (Super S Board)',
      finish: 'Dark Walnut Fluted Stripe',
      stock: 45
    },

    // ==========================================
    // SECTION C: SB POWER GADGETS & AUDIO
    // SBP-101 to SBP-110
    // Demo fixtures only; these are not supplier quotes or verified market prices.
    // ==========================================
    {
      title: 'এয়ারপডস প্রো ২ ব্ল্যাক এডিশন (AirPods Pro 2 Black) — Code: SBP-101',
      sku: 'SBP-101',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 500, // Demo fixture value
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=800&q=80',
      description: 'ব্ল্যাক রঙের প্রিমিয়াম ফিনিশ এয়ারপডস প্রো ২। অসাধারণ বেস, এএনসি ফিলিং ও দীর্ঘ ব্যাটারি ব্যাকআপ। কালো রঙের জন্য নির্ধারিত দাম ৫০০ টাকা।',
      materials: 'এবিএস ও সিলিকন টেক গ্রেড',
      finish: 'Bold Tech Black',
      stock: 150
    },
    {
      title: 'এয়ারপডস প্রো ২ হোয়াইট এডিশন (AirPods Pro 2 White) — Code: SBP-102',
      sku: 'SBP-102',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 450, // Demo fixture value
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1600294037681-c80b4cb5b434?auto=format&fit=crop&w=800&q=80',
      description: 'ক্লাসিক সাদা রঙের এয়ারপডস প্রো ২। ক্রিস্টাল ক্লিয়ার কলিং সাউন্ড ও টাচ কন্ট্রোল সুবিধা। সাদা রঙের জন্য নির্ধারিত বিশেষ দাম ৪৫০ টাকা।',
      materials: 'এবিএস গ্লসি ফিনিশ',
      finish: 'Crisp White',
      stock: 200
    },
    {
      title: 'পি৯ ওয়্যারলেস হেডসেট ৪টি কালার (P9 Wireless Headset) — Code: SBP-103',
      sku: 'SBP-103',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 420, // Demo fixture value
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80',
      description: 'পি৯ ওয়্যারলেস ব্লুটুথ ওভার-ইয়ার হেডফোন। পাওয়ারফুল স্টেরিও বেস ও আরামদায়ক কুশন। ৪টি কালার অ্যাভেলেবল (Black, Silver, Blue, Red)। দাম মাত্র ৪২০ টাকা।',
      materials: 'মেটালিক ব্যান্ড ও সফট কুশন',
      finish: '৪টি কালার অ্যাভেলেবল (4 Colors Available)',
      stock: 180
    },
    {
      title: 'এম১০ ডিজিটাল ডিসপ্লে টিডব্লিউএস বাডস (M10 TWS Bluetooth Earbuds) — Code: SBP-104',
      sku: 'SBP-104',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 350,
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1572536147248-ac59a8abfa4b?auto=format&fit=crop&w=800&q=80',
      description: 'এলইডি পাওয়ার ডিসপ্লে ও জরুরি পাওয়ার ব্যাংক হিসেবে মোবাইল চার্জ দেওয়ার সুবিধা সম্পন্ন এম১০ ব্লুটুথ হেডসেট।',
      materials: 'এবিএস ম্যাট ফিনিশ',
      finish: 'Bold Tech Black',
      stock: 250
    },
    {
      title: 'টি৫০০ ব্লুটুথ কলিং স্মার্ট ওয়াচ (T500 Bluetooth Calling Smartwatch) — Code: SBP-105',
      sku: 'SBP-105',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 550,
      reseller_commission: 100,
      commission_tab: '100tk',
      image_url: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80',
      description: 'সরাসরি ঘড়ি দিয়ে কল রিসিভ ও ডায়াল করার সুবিধা, হার্ট রেট ও ফিটনেস ট্র্যাকার সহ আকর্ষণীয় স্মার্ট ওয়াচ।',
      materials: 'মেটালিক অ্যালয় ফ্রেম ও সিলিকন স্ট্র্যাপ',
      finish: 'Electric Cyan & Tech Black',
      stock: 120
    },
    {
      title: 'এম৯০ প্রো গেমিং লো-লেটেন্সি বাডস (M90 Pro Gaming TWS Earbuds) — Code: SBP-106',
      sku: 'SBP-106',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 480,
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1606220588913-b3aacb4d2f46?auto=format&fit=crop&w=800&q=80',
      description: 'গেমিংয়ের জন্য জিরো ডিলে অডিও ও আরজিবি লাইটিং কেস সমৃদ্ধ পাওয়ারফুল ট্রু ওয়্যারলেস ব্লুটুথ ইয়ারবাডস।',
      materials: 'গেমিং আরজিবি লাইট কেসিং',
      finish: 'Bold Tech Black',
      stock: 140
    },
    {
      title: 'এফ৯-৫ ফিঙ্গারপ্রিন্ট টাচ ইয়ারবাডস (F9-5 Touch Control TWS) — Code: SBP-107',
      sku: 'SBP-107',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 380,
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1608156639585-b3a032ef9689?auto=format&fit=crop&w=800&q=80',
      description: 'ফিঙ্গারপ্রিন্ট টাচ কন্ট্রোল, হাই-ফাই সাউন্ড ও ওয়াটারপ্রুফ প্রযুক্তি সহ সেরা মূল্যের এফ৯-৫ ওয়্যারলেস ইয়ারবাডস।',
      materials: 'এবিএস টেক্সচার্ড প্লাস্টিক',
      finish: 'Dark Tech Gray',
      stock: 160
    },
    {
      title: 'টি৮০০ আল্ট্রা ২.০৯ ইঞ্চি স্মার্ট ওয়াচ (T800 Ultra Smartwatch Display) — Code: SBP-108',
      sku: 'SBP-108',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 650,
      reseller_commission: 100,
      commission_tab: '100tk',
      image_url: 'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?auto=format&fit=crop&w=800&q=80',
      description: 'বিশাল ২.০৯ ইঞ্চি এইচডি বেজেল-লেস ডিসপ্লে, ওয়্যারলেস চার্জিং ও অরেঞ্জ স্পোর্টস স্ট্র্যাপ সমৃদ্ধ প্রিমিয়াম স্মার্ট ওয়াচ।',
      materials: 'টাইটানিয়াম ফিনিশ কেস ও ওশান স্ট্র্যাপ',
      finish: 'High-Contrast Yellow & Titanium',
      stock: 110
    },
    {
      title: 'কে৮ ওয়্যারলেস কলার মাইক্রোফোন (K8 Wireless Lavalier Mic) — Code: SBP-109',
      sku: 'SBP-109',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 390,
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=800&q=80',
      description: 'টিকটক, ইউটিউব ও ফেসবুক ভিডিওর জন্য নয়েজ ক্যান্সেলেশন সমৃদ্ধ প্লাগ-অ্যান্ড-প্লে টাইপ-সি/আইফোন কলার মাইক।',
      materials: 'স্লিম ক্লিপ-অন প্লাস্টিক ও মেটাল',
      finish: 'Bold Tech Black',
      stock: 130
    },
    {
      title: 'ওয়াই৫০ সুপার ব্যাস ব্লুটুথ ইয়ারফোন (Y50 True Wireless Stereo) — Code: SBP-110',
      sku: 'SBP-110',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 290,
      reseller_commission: 50,
      commission_tab: '50tk',
      image_url: 'https://images.unsplash.com/photo-1572536147248-ac59a8abfa4b?auto=format&fit=crop&w=800&q=80',
      description: 'বাজেট মূল্যে সেরা সাউন্ড ও আকর্ষণীয় কেস সহ আল্ট্রা লাইটওয়েট ওয়াই৫০ ট্রু ওয়্যারলেস স্টেরিও ব্লুটুথ হেডসেট।',
      materials: 'হালকা এবিএস পলিমার',
      finish: 'Electric Blue & Black',
      stock: 200
    }
  ];

  for (const item of products) {
    await run(
      `INSERT OR IGNORE INTO products (
        title, sku, brand, category, regular_price, reseller_commission, commission_tab,
        image_url, description, materials, finish, stock, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        item.title,
        item.sku,
        item.brand,
        item.category,
        item.regular_price,
        item.reseller_commission,
        item.commission_tab,
        item.image_url,
        item.description,
        item.materials,
        item.finish,
        item.stock
      ]
    );
  }

  const seededCount = await get('SELECT COUNT(*) as count FROM products');
  console.log(`Successfully seeded ${seededCount.count} starter products across 3 sections.`);
};

if (require.main === module) {
  seedData()
    .then(() => {
      console.log('Seeding finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}

module.exports = { seedData };
