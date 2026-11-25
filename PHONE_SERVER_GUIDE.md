# ফোনে Backend Server চালানোর গাইড

এই সেটআপে Firebase Hosting-এর `*.web.app` ঠিকানা frontend-এর স্থায়ী লিংক থাকে। ফোনে Node.js API `127.0.0.1:3000`-এ চলে; পণ্যের ডেটা ও `/uploads` ছবিও ফোনের সার্ভার থেকে আসে। PM2 API ও tunnel watchdog চালু রাখে; watchdog Cloudflare Quick Tunnel-এর নতুন URL পরীক্ষা করে Firestore-এর `system_config/backend_tunnel` document-এ প্রকাশ করে। ব্রাউজার আগে সংরক্ষিত URL ব্যবহার করে। নতুন ব্রাউজার প্রথমবার Firestore document একবার পড়ে; পুরোনো tunnel ব্যর্থ হলে নতুন URL পেতে আরেকবার পড়ে। নিয়মিত background polling বা realtime listener চলে না, তাই Firebase read কম থাকে।

Cloudflare Quick Tunnel চালাতে Cloudflare account বা custom domain লাগে না; script email login restriction ব্যবহার করে না। URL জানা যে কেউ API-তে request পাঠাতে পারে, তাই admin/reseller কাজ server-side authentication ও rate limit দিয়ে সুরক্ষিত রাখুন।

ফোন বন্ধ, ইন্টারনেট বিচ্ছিন্ন, Android process kill, Firebase quota বা Quick Tunnel outage হলে API বন্ধ থাকবে। এটি ১০০% uptime দিতে পারে না; Cloudflare Quick Tunnel-এর কোনো uptime guarantee নেই, একবারে সর্বোচ্চ ২০০টি চলমান request সমর্থন করে এবং SSE সমর্থন করে না।

## ১. Firebase একবার সেটআপ

1. Firebase project-এ Cloud Firestore Native database এবং Web App তৈরি করুন। Firebase Console-এর Project settings → Your apps থেকে `projectId`, `apiKey`, `appId` নিন। এগুলো frontend-এর public Firebase identifiers; service-account JSON এখানে বসাবেন না।
2. Firebase Web App config বসাতে project root থেকে command চালান:

   ```bash
   npm run phone:configure-client -- "আপনার-project-id" "আপনার-web-api-key" "আপনার-web-app-id"
   ```

   command-টি `public/js/app-config.js` এবং `public-admin/js/app-config.js` দুটিতেই মান বসায়। Firebase Hosting-এ project ID domain থেকে নিজে পাওয়া যায়; native APK-র জন্যও এটি দরকার। API key ও app ID Firebase Web App config থেকে হুবহু কপি করুন। API key ও app ID public identifiers, service-account key নয়।

3. `firestore.rules`-এ এই document-এর জন্য public read এবং client write বন্ধ রাখুন:

   ```text
   match /system_config/backend_tunnel {
     allow get: if true;
     allow list, create, update, delete: if false;
   }
   ```

   Admin SDK rules অতিক্রম করে; শুধু ফোনের service account document-এ লিখবে। অন্য কোনো broad rule যেন এই document-এ client write অনুমোদন না করে তা পরীক্ষা করুন।

4. Frontend এবং rules deploy করুন:

   ```bash
   firebase deploy --only hosting,firestore:rules,firestore:indexes
   ```

## ২. ফোনে Node, cloudflared ও PM2

ফোনে Termux এবং Termux:Boot একই বিশ্বস্ত উৎস থেকে install করুন। Termux প্রথমবার খুলুন, তারপর:

```bash
pkg update -y
pkg install -y proot-distro termux-api curl
proot-distro install debian
```

Debian shell খুলুন:

```bash
proot-distro login --shared-home debian
```

Debian-এর ভেতরে Node.js 24+, SQLite native module build tools, এবং ARM64/x86-64 অনুযায়ী cloudflared install করুন:

```bash
apt update
apt install -y ca-certificates curl build-essential python3
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt install -y nodejs
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  arm64|amd64) ;;
  *) echo "Unsupported Debian architecture: $ARCH" >&2; exit 1 ;;
esac
curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" -o /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb
rm -f /tmp/cloudflared.deb /tmp/nodesource_setup.sh
```

কম্পিউটারে repository-র নিরাপদ transfer archive বানান:

```bash
npm run phone:package
```

Archive-এ `.env`, database, Firebase credential, backup key বা signing key থাকে না। `dist-phone/sb-power-phone-server.tar.gz` ফোনের private Termux home-এ কপি করুন। Termux-এ:

```bash
termux-setup-storage
mkdir -p "$HOME/sb-power-app"
tar -xzf "$HOME/storage/downloads/sb-power-phone-server.tar.gz" -C "$HOME/sb-power-app" --no-same-owner
proot-distro login --shared-home debian -- bash -lc 'cd /root/sb-power-app && npm ci --omit=dev'
```

Linux Debian/Ubuntu server-এ Node.js 24+, `build-essential`, `python3`, `curl` install করে repository root-এ একই `npm ci --omit=dev` command চালান। PM2 project dependency-তে pinned; global install দরকার নেই।

## ৩. Private server config

ফোনের Termux private storage-এ `.env` তৈরি করুন: `$HOME/sb-power-app/.env`। Debian-এ একই ফাইল `/root/sb-power-app/.env` হিসেবে দেখা যাবে। নিজের মান বসান; secret chat বা Git-এ দেবেন না।

```dotenv
PORT=3000
NODE_ENV=production
JWT_SECRET=<কমপক্ষে-৩২-অক্ষরের-এলোমেলো-secret>
ADMIN_PHONE=<আপনার-অ্যাডমিন-ফোন>
ADMIN_PASSWORD=<কমপক্ষে-১২-অক্ষরের-আলাদা-password>
CORS_ORIGIN=https://<project-id>.web.app
CORS_ORIGINS=https://<project-id>.firebaseapp.com,https://localhost,capacitor://localhost
DATABASE_FILE=/root/sb-power-app/data/database.sqlite
FIREBASE_PROJECT_ID=<project-id>
GOOGLE_APPLICATION_CREDENTIALS=/root/.config/sb-power/firebase-service-account.json
FIREBASE_BACKUP_ENCRYPTION_KEY_FILE=/root/.config/sb-power/firebase-backup.key
FIREBASE_BACKUP_RETENTION=7
```

Firebase Console থেকে শুধু Firestore লেখার অনুমতিসহ dedicated service-account JSON ডাউনলোড করে `$HOME/.config/sb-power/firebase-service-account.json`-এ রাখুন; Debian-এর shared home-এ এটি `/root/.config/sb-power/firebase-service-account.json` হবে। File permission private রাখুন (`chmod 600 ...`)। Existing encrypted backup feature চালাতে আলাদা key তৈরি করুন:

```bash
cd "$HOME/sb-power-app"
npm run firebase:make-backup-key -- "$HOME/.config/sb-power/firebase-backup.key"
chmod 600 "$HOME/.config/sb-power/firebase-backup.key"
```

`CORS_ORIGIN(S)`-এ আপনার আসল Hosting origin লিখুন। নতুন কোডে শুধু ওই নির্দিষ্ট origin এবং নিজের `FIREBASE_PROJECT_ID`-এর exact `*.web.app` / `*.firebaseapp.com` domain অনুমোদিত; অন্য যেকোনো Firebase সাবডোমেইন বন্ধ।

## ৪. চালু, যাচাই ও log rotation

Debian shell-এ:

```bash
cd /root/sb-power-app
mkdir -p logs
npm run pm2:start
./node_modules/.bin/pm2 status
curl -fsS http://127.0.0.1:3000/health
```

PM2 `sb-power-app` এবং `sb-power-tunnel-watchdog` দুটোই চালাবে। Watchdog `cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate` চালায়, tunnel URL পেলে public `/health` যাচাই করে, তারপর Firestore-এ URL/status লেখে। প্রতি ৬০ সেকেন্ডে public health যাচাই হয়; ব্যর্থ হলে tunnel restart হয় এবং backoff ১ সেকেন্ড থেকে সর্বোচ্চ ৬০ সেকেন্ডে বাড়ে।

PM2 log যাতে storage না ভরে, একবার চালান:

```bash
./node_modules/.bin/pm2 install pm2-logrotate
./node_modules/.bin/pm2 set pm2-logrotate:max_size 10M
./node_modules/.bin/pm2 set pm2-logrotate:retain 5
./node_modules/.bin/pm2 set pm2-logrotate:compress true
./node_modules/.bin/pm2 save
```

App SQLite database `data/database.sqlite`-এ থাকে। Production-এ startup-এ এবং প্রতি ৬ ঘণ্টায় SQLite snapshot হয়; local backup সর্বশেষ ৩০টি রাখা হয়। Backup-কে verified copy/restore policy হিসেবে দেখুন, live failover হিসেবে নয়।

## ৫. Termux auto-boot এবং Android

Termux:Boot app install করার পরে অন্তত একবার খুলুন। Termux-এ boot script কপি ও executable করুন:

```bash
mkdir -p "$HOME/.termux/boot"
cp "$HOME/sb-power-app/scripts/termux-boot-start.sh" "$HOME/.termux/boot/termux-boot-start.sh"
chmod 700 "$HOME/.termux/boot/termux-boot-start.sh"
```

Android Settings-এ Termux, Termux:Boot এবং Termux:API-এর battery usage **Unrestricted** দিন। `termux-wake-lock` CPU-কে awake রাখে; চার্জার ও নির্ভরযোগ্য Wi-Fi ব্যবহার করুন।

Android 12+ ফোন USB debugging চালু করে কম্পিউটারের ADB থেকে নিচের command দিন; Android 14+ কিছু ফোনে Developer options → **Disable child process restrictions** চালু করাও লাগতে পারে:

```bash
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647"
adb shell "settings put global settings_enable_monitor_phantom_procs false"
adb shell "/system/bin/device_config get activity_manager max_phantom_processes"
```

শেষ command-এ `2147483647` দেখা উচিত। ফোন প্রস্তুত হলে Termux:Boot থেকে ৫ মিনিট পর্যন্ত network-এর জন্য অপেক্ষা করে PM2 resurrect হবে; timeout হলেও server চালু হবে এবং tunnel নিজে retry করবে।

## ৬. Optional Tailscale Funnel

Static `*.ts.net` URL চাইলে Linux/Termux environment-এ Tailscale CLI ও `tailscaled` install এবং login করুন। Tailscale Admin Console-এ HTTPS ও Funnel অনুমতি চালু করে:

```bash
cd /root/sb-power-app
./scripts/start-tailscale-funnel.sh
```

Script Termux-এ `--tun=userspace-networking` ব্যবহার করে; Linux-এ `TAILSCALE_MODE=kernel` বা `userspace` বেছে নেয়। Termux userspace setup-এ Funnel কাজ করবে—এটি deployment-এর আগে `tailscale funnel status` ও অন্য নেটওয়ার্ক থেকে `/health` দিয়ে যাচাই করুন। Funnel-এ পৌঁছাতে Tailscale account এবং tailnet লাগে। Personal free plan non-commercial ব্যবহারের জন্য; ব্যবসায়িক ব্যবহার হলে plan-এর শর্ত আগে যাচাই করুন।

## চালু অবস্থার সীমা

Quick Tunnel-এর URL প্রতিটি নতুন tunnel-এ বদলায়। Watchdog Firestore আপডেট করে, কিন্তু Frontend চলতে Firestore read অনুমতি ও Firebase Web App config দরকার। ফোনের বিদ্যুৎ/নেটওয়ার্ক, Android background process policy, Firebase quota, tunnel provider-এর সীমা বা phone storage-এর ওপর এই ব্যবস্থার control নেই।
