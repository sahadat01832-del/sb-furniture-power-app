const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { normalizePublicApiUrl, publishPhoneApiUrl } = require('../src/firebaseConnection');

async function main() {
  const suppliedUrl = process.argv[2] || process.env.PHONE_PUBLIC_API_URL || '';
  if (!suppliedUrl) {
    throw new Error('Pass the current public HTTPS URL. PM2 runs the tunnel watchdog automatically.');
  }
  const result = await publishPhoneApiUrl(normalizePublicApiUrl(suppliedUrl));
  console.log(`Firestore now points to the phone API at ${result.apiUrl}`);
}

main().catch((error) => {
  const code = error && error.code ? error.code : 'connection_publish_failed';
  console.error(`Could not publish the phone API address to Firebase (${code}).`);
  process.exitCode = 1;
});
