# SB Furniture ও SB POWER Social Commerce App

এই অ্যাপে নিজের পণ্য ও পার্টনার দোকানের পণ্য তালিকাভুক্ত করা যায়। ক্রেতা অর্ডার করতে পারে, আর যে কেউ পণ্য শেয়ার করে সফল বিক্রিতে সেই পণ্যের জন্য admin-নির্ধারিত সরাসরি কমিশন পেতে পারে। নতুন signup-এর ওপর কোনো bonus বা team commission দেওয়া হয় না।

## লোকালভাবে চালানো

প্রথমবার dependencies ইনস্টল করে environment file বানান:

```bash
npm install
cp .env.example .env
```

`.env`-এ `JWT_SECRET`, `ADMIN_PHONE`, `ADMIN_PASSWORD` এবং প্রয়োজনে `DATABASE_FILE` সেট করুন। Secret বা password Git-এ যোগ করবেন না। এরপর চালান:

```bash
npm start
```

- ক্রেতা ও রিসেলার অ্যাপ: `http://localhost:3000`
- অ্যাডমিন প্যানেল: `http://localhost:3000/admin.html`

সার্ভার চালু হলে খালি database-এ admin account তৈরি হয়। আসল পণ্য admin প্যানেল থেকে যোগ করুন। Demo catalog স্বয়ংক্রিয়ভাবে চালু হয় না।

## এখনকার অ্যাপের কাজ

- ফোন নম্বর দিয়ে account, login, password change ও order history
- পণ্যের catalog, search, filter, product-specific reseller commission এবং share link
- customer order, order tracking, order status history ও notification
- COD order এবং manual advance-payment TrxID জমা
- admin product ও partner-shop তথ্য, announcement, order, user, payout request ও backup পরিচালনা
- direct seller commission: admin `delivered` করলে কমিশন wallet-এ available হয়
- বাস্তব delivered order-এর reseller তালিকা; কোনো demo নাম বা prize promise নেই

## পার্টনার দোকান ও Paperfly

পণ্যে shop name, vendor phone, badge ও address রাখার সুবিধা আছে। Paperfly account-এ অর্ডার পাঠানো বা tracking update করার automatic integration এখনো নেই; admin-কে Paperfly merchant panel-এ shipment তৈরি করতে হয়। এক অর্ডারে একাধিক shop থাকলে আলাদা shipment ও seller settlement হিসাবও এখনো নেই।

বর্তমান delivery fee code ঢাকা-ভিতরে/ঢাকা-বাইরের পুরোনো fixed rate ব্যবহার করে। কালীগঞ্জ–গাজীপুর launch-এর জন্য origin, destination zone, parcel weight ও COD fee অনুযায়ী নতুন হিসাব লাগবে। Paperfly-এর শর্তে ৫ কেজির বেশি/heavy furniture parcel নেয় না; furniture-এর জন্য local pickup বা আলাদা transport দরকার। Merchant account-এর নিজের rate যাচাই করে তারপর checkout fee ঠিক করুন।

Advance payment-এর TrxID গ্রাহক নিজে দিতে পারে; অ্যাপ provider-এর মাধ্যমে payment verify করে না। Admin-কে নিজের merchant/payment account-এ টাকা মিলিয়ে order confirm করতে হবে।

## ব্যবসার হিসাবের নিয়ম

প্রতি পণ্যের কমিশন সেট করার আগে হিসাব করুন:

`বিক্রয়দাম - supplier/তৈরির খরচ - reseller commission - payment/COD খরচ - packaging/return খরচ - delivery subsidy - কর = আনুমানিক contribution`

পার্টনার পণ্যের ক্ষেত্রে shop-এর পাওনা ও platform commission-ও চুক্তিতে লিখতে হবে। Product table-এ এখনো supplier cost বা shop settlement ledger নেই; তাই অ্যাপ এখনো প্রতি পণ্যের নিট লাভ দেখাতে পারে না।

## APK তৈরি

Android SDK/Java প্রস্তুত থাকলে এবং release signing-এর credentials `.env`-এ সেট থাকলে:

```bash
npm run build:apks
```

শুধু client বা admin APK চাইলে `npm run build:apk:client` অথবা `npm run build:apk:admin` চালান। APK-গুলো `dist-apk/`-এ তৈরি হয়।
Release key প্রকল্প ফোল্ডারের বাইরে রাখতে হবে। `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` গোপন `.env` ফাইলে দিন; APK build command `.env` থেকে এগুলো পড়ে। `.env` বা keystore কাউকে পাঠাবেন না।

## পরীক্ষা

```bash
npm test
```

Test suite আলাদা temporary SQLite database ব্যবহার করে; আসল app database পরিষ্কার বা বদলায় না। Demo products শুধু test fixture হিসেবে স্পষ্টভাবে seed করা হয়।

## Cloud hosting (Render)

অ্যাপের বর্তমান Render service `sb-furniture-power-app`; public link `https://sb-furniture-power-app.onrender.com` এবং এই মুহূর্তে `/health` সফল। সার্ভার Render-এ চলে, তাই নিজের PC বন্ধ থাকলেও চালু থাকতে পারে। এখন service Free plan-এ, ফলে ১৫ মিনিট traffic না থাকলে sleep করে, আবার জাগতে প্রায় এক মিনিট লাগে; Free filesystem-এর SQLite data restart, deploy বা sleep-এ হারাতে পারে।

`render.yaml` একই service-কে paid always-on plan-এ তুলবে, `/var/data`-এ 1 GB persistent disk যোগ করবে এবং `/health` check চালু করবে। Oregon region বাদ রাখা হয়েছে যাতে বিদ্যমান location-ই থাকে। ছোট 0.5 CPU / 512 MB plan $7/মাস এবং 1 GB disk প্রায় $0.25/মাস; bandwidth, কর বা অন্য usage হলে মোট বাড়তে পারে। Disk এক instance-এ সীমাবদ্ধ করে এবং deploy-এর সময় কয়েক সেকেন্ডের বিরতি হতে পারে।

Blueprint-টি `codex/hosted-backend` branch থেকে একই service-এ প্রস্তাবিত পরিবর্তন preview করবে। Existing Render URL-ই থাকবে; নতুন service বা নতুন link তৈরি করার কথা নয়। বর্তমান `JWT_SECRET`, admin credentials ও অন্য secret Blueprint-এ লেখা নেই, যাতে sync-এ সেগুলো বদলে না যায়। `.env`, `data/`, database backup, APK ও release keystore Git-এ দেবেন না।

লোকাল backup-এ পণ্য, ব্যবহারকারী ও অর্ডার আছে। Blueprint apply করলে ওই backup নিজে থেকে Render-এ যাবে না; live service-এর বর্তমান SQLite-ও আগে export করে যাচাই করতে হবে। Disk attach/redeploy-এর আগে দুই দিকের backup ও restore ধাপ ঠিক করা জরুরি। কোনো customer-এর নাম, ফোন, ঠিকানা বা order history cloud-এ পাঠানোর আগে মালিকের অনুমতি নিন।

## Production-এর আগে

- Production server startup-এ এবং প্রতি 24 ঘণ্টায় একটি SQLite backup তৈরি করে, সর্বশেষ 30টি রাখে। ফাইলগুলো Render disk-এই থাকে; আলাদা offsite backup এখনো স্বয়ংক্রিয় নয়।
- Paperfly fee ও pickup origin, furniture transport, partner settlement, return policy এবং commission ছাড়ার সময় নির্দিষ্ট করুন।
- GitHub repository বর্তমানে public, এবং পুরোনো release keystore Git history-তে আছে। সেই key exposed ধরে নিন। নতুন APK-তে এটি ব্যবহার করবেন কি না তা সিদ্ধান্তের আগে জেনে নিন: sideloaded app-এর signing key বদলালে পুরোনো install সরাসরি update নাও নিতে পারে।
- বাংলা Terms-এ delivery, cancellation, return, refund ও after-sales শর্ত লিখুন।
