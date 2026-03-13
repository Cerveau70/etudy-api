const admin = require('firebase-admin');
const key = require('../keys/etudy-f869d-firebase-adminsdk-fbsvc-ee4f35b827.json');
admin.initializeApp({ credential: admin.credential.cert(key), databaseURL: 'https://etudy-f869d-default-rtdb.firebaseio.com' });
admin.database().ref('arena_live/top3').get()
  .then(snap => {
    console.log('arena_live/top3:', JSON.stringify(snap.val(), null, 2));
    process.exit(0);
  });
