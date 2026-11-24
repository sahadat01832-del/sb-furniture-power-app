const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getAdminFirestore, CONFIG_COLLECTION } = require('../src/firebaseConnection');

const OMNIROUTE_PORT = process.env.OMNIROUTE_PORT || 20128;

function getPrimaryLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Find non-internal IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

async function publishPCOmniRoute() {
  const ip = getPrimaryLocalIPv4();
  const endpoint = process.env.PC_OMNIROUTE_CUSTOM_URL || `http://${ip}:${OMNIROUTE_PORT}`;
  
  console.log(`🔍 Detected PC OmniRoute LAN endpoint: ${endpoint}`);

  try {
    const db = await getAdminFirestore();
    const docRef = db.collection(CONFIG_COLLECTION || 'system_config').doc('omniroute_pc_endpoint');
    
    await docRef.set({
      endpoint,
      ip,
      port: Number(OMNIROUTE_PORT),
      updated_at: new Date().toISOString(),
      status: 'online'
    }, { merge: true });

    console.log(`✅ Successfully published PC OmniRoute endpoint to Firestore (${endpoint})`);
  } catch (error) {
    console.warn(`⚠️ Could not publish to Firestore (${error.message}). Local fallback will be used.`);
  }
}

if (require.main === module) {
  publishPCOmniRoute().catch(console.error);
}

module.exports = {
  getPrimaryLocalIPv4,
  publishPCOmniRoute
};
