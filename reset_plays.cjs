const admin = require('firebase-admin');
const key = require('../keys/etudy-f869d-firebase-adminsdk-fbsvc-ee4f35b827.json');
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

async function reset() {
  const today = new Date().toISOString().split('T')[0];
  const snap = await db.collection('arena_plays')
    .where('date', '==', today)
    .get();
  
  if (snap.empty) { console.log('Aucun play trouvé pour aujourd\'hui'); process.exit(0); }
  
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  console.log(`Supprime: ${snap.size} plays pour ${today}`);
  process.exit(0);
}
reset().catch(e => { console.error(e); process.exit(1); });
