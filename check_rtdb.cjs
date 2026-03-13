const admin = require('firebase-admin');
const key = require('../keys/etudy-f869d-firebase-adminsdk-fbsvc-ee4f35b827.json');
admin.initializeApp({ credential: admin.credential.cert(key), databaseURL: 'https://etudy-f869d-default-rtdb.firebaseio.com' });
admin.database().ref('daily_questions/2026-03-12').get()
  .then(snap => {
    if (!snap.exists()) { console.log('Rien dans la RTDB'); }
    else { console.log('Questions trouvees:', Object.keys(snap.val()).length); }
    process.exit(0);
  });
