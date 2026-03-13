/**
 * ETUDY API Server — Express (remplace Firebase Functions)
 * Déploiement : Render.com (gratuit)
 *
 * Routes identiques aux Cloud Functions :
 *   POST /startArenaSession
 *   POST /submitAnswer
 *   POST /finishArena
 *   POST /initPassPayment
 *   POST /geniusPayWebhook
 *   GET  /getUserPasses
 *   POST /sendAdminNotification
 */

import express     from 'express';
import cors        from 'cors';
import crypto      from 'crypto';
import admin       from 'firebase-admin';

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── Firebase Admin init ── */
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: 'https://etudy-f869d-default-rtdb.firebaseio.com/',
});

const db   = admin.firestore();
const rtdb = admin.database();

/* ── Middleware ── */
app.use(cors({ origin: '*' }));
app.use(express.json());

/* ══════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════ */
const MANCHE_DURATION_S    = 420;
const QUESTIONS_PER_MANCHE = 25;
const XP_INCORRECT         = -2;
const XP_FLOOR             = 75;

const GENIUSPAY_SECRET     = process.env.GENIUSPAY_SECRET     || '';  // secret webhook HMAC
const GENIUSPAY_API_KEY    = process.env.GENIUSPAY_API_KEY    || '';  // clé publique pk_live_...
const GENIUSPAY_API_SECRET = process.env.GENIUSPAY_API_SECRET || '';  // clé secrète sk_live_...
const GENIUSPAY_API_URL    = 'https://pay.genius.ci/api/v1/merchant';

const PASS_DEFS = {
  'm-1':       { days: 1,  keys: 1    },
  'm-3':       { days: 3,  keys: 3    },
  'm-week':    { days: 7,  keys: null },
  'm-month':   { days: 30, keys: null },
  'c-basic':   { days: 30, keys: null },
  'c-elite':   { days: 30, keys: null },
  'e-pack':    { days: 30, keys: 10   },
  'e-total':   { days: 30, keys: null },
  'vs-start':  { days: 7,  keys: 3    },
  'vs-pro':    { days: 15, keys: 10   },
  'vs-legend': { days: 30, keys: null },
};

const PASS_PRICES = {
  'm-1': 100, 'm-3': 250, 'm-week': 1500, 'm-month': 3000,
  'c-basic': 1000, 'c-elite': 2000,
  'e-pack': 1200, 'e-total': 3500,
  'vs-start': 500, 'vs-pro': 1500, 'vs-legend': 4000,
};

const FINAL_AFFRONT_SERVER = [
  { id:'af1', text:'Théorème de Fermat : aucune solution entière pour x^n+y^n=z^n avec n>2 ?', options:['Vrai','Faux','Seulement pour n pair','Seulement pour n premier'], correct:0, xp:10 },
  { id:'af2', text:'dy/dx = 2xy → solution générale ?', options:['Ce^(x^2)','Ce^x','x^2+C','2x+C'], correct:0, xp:10 },
  { id:'af3', text:'Complexité du tri fusion ?', options:['O(n log n)','O(n^2)','O(n)','O(log n)'], correct:0, xp:10 },
];

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
const todayStr = () => new Date().toISOString().slice(0, 10);


const hasActiveManchePass = async (uid) => {
  const snap = await db
    .collection('user_passes').doc(uid)
    .collection('passes')
    .where('cat', '==', 'm')
    .where('expiresAt', '>', admin.firestore.Timestamp.now())
    .get();
  for (const doc of snap.docs) {
    const p = doc.data();
    if (p.keysLeft === null || p.keysLeft > 0) return true;
  }
  return false;
};

const consumePassKey = async (uid) => {
  const snap = await db
    .collection('user_passes').doc(uid)
    .collection('passes')
    .where('cat', '==', 'm')
    .where('expiresAt', '>', admin.firestore.Timestamp.now())
    .orderBy('expiresAt', 'asc')
    .limit(1)
    .get();
  if (snap.empty) return;
  const docRef = snap.docs[0].ref;
  const data   = snap.docs[0].data();
  if (data.keysLeft !== null) {
    await docRef.update({ keysLeft: admin.firestore.FieldValue.increment(-1) });
  }
};

const verifyToken = async (req) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) throw new Error('NO_TOKEN');
  const token   = auth.split('Bearer ')[1];
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded.uid;
};

/* ══════════════════════════════════════════════
   HEALTH CHECK
══════════════════════════════════════════════ */
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ETUDY API', version: '1.0.0' });
});

/* ══════════════════════════════════════════════
   1. startArenaSession
══════════════════════════════════════════════ */
app.post('/startArenaSession', async (req, res) => {
  try {
    // === LOGS DÉTAILLÉS POUR DÉBOGUER LE 403 ===
    console.log("=== START ARENA SESSION DEBUG ===");
    console.log("Authorization header:", req.headers.authorization);
    
    const uid = await verifyToken(req);
    console.log("Decoded token UID:", uid);
    
    const user = await admin.auth().getUser(uid);
    console.log("User data:", {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      isAnonymous: user.isAnonymous,
      disabled: user.disabled,
      emailVerified: user.emailVerified
    });

    const mancheId = Number(req.body.mancheId);


    const playKey = `${uid}_${todayStr()}_${mancheId}`;
    console.log("Play key:", playKey);
    
    const playDoc = await db.collection('arena_plays').doc(playKey).get();
    console.log("Play document exists:", playDoc.exists);
    
    if (playDoc.exists) {
      console.log("❌ REASON: ALREADY_PLAYED - User already played this manche");
      return res.status(409).json({ error: 'ALREADY_PLAYED' });
    }

    const hasPas = await hasActiveManchePass(uid);
    console.log("Has active manche pass:", hasPas);
    
    if (!hasPas) {
      console.log("❌ REASON: NO_PASS - User has no active pass");
      return res.status(402).json({ error: 'NO_PASS' });
    }

    const existingSnap = await db.collection('arena_sessions')
      .where('uid', '==', uid).where('status', '==', 'active').get();
    console.log("Existing active sessions count:", existingSnap.size);
    
    if (!existingSnap.empty) {
      console.log("❌ REASON: SESSION_ACTIVE - User has another active session");
      return res.status(409).json({ error: 'SESSION_ACTIVE' });
    }

    const questionsSnap = await rtdb.ref(`daily_questions/${todayStr()}`).get();
    if (!questionsSnap.exists()) {
      return res.status(503).json({ error: 'NO_QUESTIONS' });
    }
    const allQuestions = Object.values(questionsSnap.val());
    const shuffled = allQuestions.sort(() => Math.random() - 0.5).slice(0, QUESTIONS_PER_MANCHE);

    const questionsWithShuffledOptions = shuffled.map((q) => {
      const indices = q.options.map((_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      return {
        id: q.id, text: q.text,
        options: indices.map(i => q.options[i]),
        xp: q.xp, difficulte: q.difficulte,
        _correctIdx: indices.indexOf(q.correct),
      };
    });

    const sessionRef = db.collection('arena_sessions').doc();
    const startedAt  = admin.firestore.Timestamp.now();
    const expiresAt  = new Date(startedAt.toMillis() + (MANCHE_DURATION_S + 10) * 1000);

    await sessionRef.set({
      uid, mancheId, status: 'active', startedAt,
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      currentQIndex: 0, xp: 0, answerCount: 0,
      lastAnswerAt: startedAt,
      questions: questionsWithShuffledOptions,
    });

    await consumePassKey(uid);
    await db.collection('arena_plays').doc(playKey).set({
      uid, mancheId, date: todayStr(), sessionId: sessionRef.id, createdAt: startedAt,
    });

    const clientQuestions = questionsWithShuffledOptions.map(({ _correctIdx, ...q }) => q);
    return res.status(200).json({
      sessionId: sessionRef.id, questions: clientQuestions,
      startedAt: startedAt.toMillis(), durationMs: MANCHE_DURATION_S * 1000,
    });

  } catch (err) {
    if (err.message === 'NO_TOKEN') return res.status(401).json({ error: 'UNAUTHORIZED' });
    console.error('[startArenaSession]', err);
    return res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

/* ══════════════════════════════════════════════
   2. submitAnswer
══════════════════════════════════════════════ */
app.post('/submitAnswer', async (req, res) => {
  try {
    const uid = await verifyToken(req);
    const { sessionId, qIndex, answerIdx } = req.body;

    const sessionRef  = db.collection('arena_sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });

    const session = sessionSnap.data();
    if (session.uid !== uid) return res.status(403).json({ error: 'FORBIDDEN' });

    const now = Date.now();
    if (now > session.expiresAt.toMillis()) {
      await sessionRef.update({ status: 'expired' });
      return res.status(410).json({ error: 'SESSION_EXPIRED', xp: session.xp });
    }
    if (qIndex !== session.currentQIndex) {
      return res.status(409).json({ error: 'WRONG_QINDEX' });
    }

    const question   = session.questions[qIndex];
    const isCorrect  = answerIdx === question._correctIdx;
    const xpGained   = isCorrect ? question.xp : XP_INCORRECT;
    const newXP      = session.xp + xpGained;
    const nextQIndex = qIndex + 1;
    const done       = nextQIndex >= session.questions.length;

    await sessionRef.update({
      xp: newXP, currentQIndex: nextQIndex,
      answerCount: admin.firestore.FieldValue.increment(1),
      lastAnswerAt: admin.firestore.Timestamp.now(),
      ...(done ? { status: 'completed' } : {}),
    });

    const userRecord = await admin.auth().getUser(uid);
    await rtdb.ref(`arena_live/top3/${uid}`).set({
      uid, displayName: userRecord.displayName ?? 'Player',
      photoURL: userRecord.photoURL ?? '', score: newXP,
    });

    return res.status(200).json({
      correct: isCorrect, correctIdx: question._correctIdx,
      xpGained, totalXP: newXP, nextQIndex, done,
    });

  } catch (err) {
    if (err.message === 'NO_TOKEN') return res.status(401).json({ error: 'UNAUTHORIZED' });
    console.error('[submitAnswer]', err);
    return res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

/* ══════════════════════════════════════════════
   3. finishArena
══════════════════════════════════════════════ */
app.post('/finishArena', async (req, res) => {
  try {
    const uid = await verifyToken(req);
    const { sessionId, affrontAnswers } = req.body;

    const sessionRef  = db.collection('arena_sessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });

    const session = sessionSnap.data();
    if (session.uid !== uid)        return res.status(403).json({ error: 'FORBIDDEN' });
    if (session.status === 'saved') return res.status(409).json({ error: 'ALREADY_SAVED' });

    let finalXP = session.xp;
    if (Array.isArray(affrontAnswers) && affrontAnswers.length === FINAL_AFFRONT_SERVER.length) {
      finalXP += affrontAnswers.reduce((acc, ans, i) =>
        acc + (ans === FINAL_AFFRONT_SERVER[i].correct ? FINAL_AFFRONT_SERVER[i].xp : 0), 0);
    }

    const top3Snap = await rtdb.ref('arena_live/top3').get();
    const top3     = top3Snap.val() ? Object.values(top3Snap.val()) : [];
    const sorted   = top3.sort((a, b) => b.score - a.score);
    const isTopPlayer = sorted[0]?.uid === uid && finalXP >= XP_FLOOR;

    if (isTopPlayer && !affrontAnswers) {
      return res.status(200).json({
        needsAffront: true,
        affrontQuestions: FINAL_AFFRONT_SERVER.map(({ correct, ...q }) => q),
        currentXP: finalXP,
      });
    }

    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async tx => {
      const userDoc = await tx.get(userRef);
      const prev   = userDoc.exists ? (userDoc.data()?.score ?? 0) : 0;
      const prevXP = userDoc.exists ? (userDoc.data()?.xp    ?? 0) : 0;
      tx.set(userRef, {
        score: prev + finalXP, xp: prevXP + finalXP,
        lastDefiDate: new Date().toISOString(), lastMancheId: session.mancheId,
      }, { merge: true });
    });

    await sessionRef.update({ status: 'saved', finalXP });
    await rtdb.ref(`arena_live/top3/${uid}`).remove();

    return res.status(200).json({ xp: finalXP, saved: true });

  } catch (err) {
    if (err.message === 'NO_TOKEN') return res.status(401).json({ error: 'UNAUTHORIZED' });
    console.error('[finishArena]', err);
    return res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

/* ══════════════════════════════════════════════
   4. initPassPayment
══════════════════════════════════════════════ */
app.post('/initPassPayment', async (req, res) => {
  try {
    const uid = await verifyToken(req);
    const { passId, phoneNumber } = req.body;

    if (!PASS_PRICES[passId]) return res.status(400).json({ error: 'INVALID_PASS' });

    const amount     = PASS_PRICES[passId];
    const txId       = crypto.randomUUID();
    const userRecord = await admin.auth().getUser(uid);

    await db.collection('pay_transactions').doc(txId).set({
      txId, uid, passId, amount,
      phone: phoneNumber, email: userRecord.email ?? '',
      status: 'pending', createdAt: admin.firestore.Timestamp.now(),
    });

    const API_BASE_URL = process.env.API_BASE_URL || `https://etudy-api.onrender.com`;

    const gpRes = await fetch(`${GENIUSPAY_API_URL}/transactions/init`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-API-Key':     GENIUSPAY_API_KEY,     // pk_live_...
        'Authorization': `Bearer ${GENIUSPAY_API_SECRET}`, // sk_live_...
      },
      body: JSON.stringify({
        amount, currency: 'XOF',
        description: `ETUDY Pass ${passId}`,
        reference:   txId,
        customer: {
          phone: phoneNumber,
          email: userRecord.email ?? '',
          name:  userRecord.displayName ?? 'Étudiant',
        },
        return_url:  `https://etudy.app/payment/success?tx=${txId}`,
        webhook_url: `${API_BASE_URL}/geniusPayWebhook`,
        channels:    ['wave', 'orange_money', 'mtn_money'],
      }),
    });

    if (!gpRes.ok) {
      const errText = await gpRes.text();
      await db.collection('pay_transactions').doc(txId).update({ status: 'gp_error', gpError: errText });
      return res.status(502).json({ error: 'PAYMENT_INIT_FAILED' });
    }

    const gpData = await gpRes.json();
    await db.collection('pay_transactions').doc(txId).update({
      gpTxId:     gpData.transaction_id ?? gpData.id ?? '',
      paymentUrl: gpData.payment_url    ?? gpData.url ?? '',
      status:     'initiated',
    });

    return res.status(200).json({
      txId,
      paymentUrl: gpData.payment_url ?? gpData.url,
      gpTxId:     gpData.transaction_id ?? gpData.id,
    });

  } catch (err) {
    if (err.message === 'NO_TOKEN') return res.status(401).json({ error: 'UNAUTHORIZED' });
    console.error('[initPassPayment]', err);
    return res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

/* ══════════════════════════════════════════════
   5. geniusPayWebhook
══════════════════════════════════════════════ */
app.post('/geniusPayWebhook', async (req, res) => {
  try {
    // ✅ FIX: GeniusPay envoie X-Webhook-Signature (+ X-Webhook-Timestamp)
    const signature = req.headers['x-webhook-signature'] ?? '';
    const timestamp = req.headers['x-webhook-timestamp'] ?? '';
    const rawBody   = JSON.stringify(req.body);
    // Signature = HMAC-SHA256(timestamp + '.' + rawBody, secret)
    const expected  = crypto.createHmac('sha256', GENIUSPAY_SECRET)
                            .update(timestamp + '.' + rawBody)
                            .digest('hex');

    if (signature !== expected) {
      console.warn('[geniusPayWebhook] Signature invalide');
      return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    }

    const { reference: txId, status, transaction_id: gpTxId } = req.body;

    const txRef  = db.collection('pay_transactions').doc(txId);
    const txSnap = await txRef.get();
    if (!txSnap.exists) return res.status(404).json({ error: 'TX_NOT_FOUND' });

    const tx = txSnap.data();
    if (tx.status === 'completed') return res.status(200).json({ ok: true });

    await txRef.update({ status: 'webhook_received', gpTxId, webhookPayload: req.body });

    if (status === 'successful' || status === 'success') {
      const passDef = PASS_DEFS[tx.passId];
      if (!passDef) return res.status(400).json({ error: 'INVALID_PASS_DEF' });

      const exp = new Date();
      exp.setDate(exp.getDate() + passDef.days);

      // ✅ Écriture du pass dans user_passes/{uid}/passes/
      const passRef = db.collection('user_passes').doc(tx.uid).collection('passes').doc();
      await passRef.set({
        passId:    tx.passId,
        cat:       tx.passId.split('-')[0],
        keysLeft:  passDef.keys,
        expiresAt: admin.firestore.Timestamp.fromDate(exp),
        txId,
        createdAt: admin.firestore.Timestamp.now(),
      });

      // ✅ Enregistrement dans passSales pour le dashboard admin
      await db.collection('passSales').doc(passRef.id).set({
        userId:      tx.uid,
        passType:    tx.passId,
        amount:      tx.amount,
        phone:       tx.phone,
        createdAt:   admin.firestore.Timestamp.now(),
        expiresAt:   exp.toISOString(),
        manchesLeft: passDef.keys,
        status:      'active',
        txId,
        gpTxId,
      });

      await txRef.update({ status: 'completed', activatedAt: admin.firestore.Timestamp.now() });

      // ✅ Notif RTDB → le client fetchPasses() automatiquement
      await rtdb.ref(`user_notifications/${tx.uid}/pass_activated`).set({
        passId: tx.passId, expiresAt: exp.toISOString(), ts: Date.now(),
      });
    } else {
      await txRef.update({ status: `failed_${status}` });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[geniusPayWebhook]', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ══════════════════════════════════════════════
   6. getUserPasses
══════════════════════════════════════════════ */
app.get('/getUserPasses', async (req, res) => {
  try {
    const uid  = await verifyToken(req);
    const snap = await db
      .collection('user_passes').doc(uid)
      .collection('passes')
      .where('expiresAt', '>', admin.firestore.Timestamp.now())
      .get();

    const passes = snap.docs.map(d => ({
      id:        d.id,
      passId:    d.data().passId,
      cat:       d.data().cat,
      keysLeft:  d.data().keysLeft,
      expiresAt: d.data().expiresAt.toDate().toISOString(),
    }));

    return res.status(200).json({ passes });

  } catch (err) {
    if (err.message === 'NO_TOKEN') return res.status(401).json({ error: 'UNAUTHORIZED' });
    return res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ══════════════════════════════════════════════
   7. sendAdminNotification
══════════════════════════════════════════════ */
app.post('/sendAdminNotification', async (req, res) => {
  try {
    const uid = await verifyToken(req);
    const user = await admin.auth().getUser(uid);

    if (user.email !== 'allomajean@gmail.com') {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    const { title, body, targetAll, userId } = req.body;

    // Log dans Firestore
    await db.collection('notificationLogs').add({
      title, body,
      sentAt: admin.firestore.Timestamp.now(),
      sentCount: targetAll ? 999 : 1,
      targetAll: targetAll ?? false,
      userId: userId ?? null,
    });

    // Si tu as FCM configuré plus tard, ajoute l'envoi ici
    // Pour l'instant on log uniquement

    return res.status(200).json({ ok: true, message: 'Notification logged' });

  } catch (err) {
    if (err.message === 'NO_TOKEN') return res.status(401).json({ error: 'UNAUTHORIZED' });
    console.error('[sendAdminNotification]', err);
    return res.status(500).json({ error: 'INTERNAL', message: err.message });
  }
});

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`✅ ETUDY API running on port ${PORT}`);



});



// GET /getUserPasses
app.get('/getUserPasses', verifyToken, async (req, res) => {
  const uid = req.uid;
  const now = new Date();
  try {
    const snap = await db.collection('user_passes').doc(uid)
      .collection('passes')
      .where('expiresAt', '>', now)
      .get();
    const passes = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.keysLeft === null || p.keysLeft > 0)
      .map(p => ({
        id:          p.id,
        passType:    p.cat === 'm' ? 'manche' : p.cat === 'q' ? 'quotidien' : p.cat === '3j' ? '3jours' : 'premium',
        manchesLeft: p.keysLeft ?? null,
        expiresAt:   p.expiresAt.toDate().toISOString(),
        xpBonus:     p.xpBonus ?? 0,
      }));
    res.json({ passes });
  } catch (err) {
    console.error('[getUserPasses]', err);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

/* ══════════════════════════════════════════════
   8. getMancheStatus (Endpoint pour synchroniser l'heure avec le frontend)
══════════════════════════════════════════════ */