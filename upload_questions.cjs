/**
 * Upload les questions de src/data/defis/quotidiens/ vers RTDB
 * Usage: node upload_questions.js [date] (ex: 2026-03-12, défaut = aujourd'hui)
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

// ── Config ──────────────────────────────────────────────
const KEY_PATH  = '../keys/etudy-f869d-firebase-adminsdk-fbsvc-ee4f35b827.json';
const DATA_DIR  = '../src/data/defis/quotidiens';
const RTDB_URL  = 'https://etudy-f869d-default-rtdb.firebaseio.com';
const TARGET_DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
// ────────────────────────────────────────────────────────

admin.initializeApp({
  credential:  admin.credential.cert(require(KEY_PATH)),
  databaseURL: RTDB_URL,
});

const db = admin.database();

// Parcourt récursivement un dossier et retourne tous les .json
function findJsonFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(findJsonFiles(full));
    else if (entry.name.endsWith('.json')) results.push(full);
  }
  return results;
}

async function main() {
  console.log(`\n📅 Cible RTDB : daily_questions/${TARGET_DATE}`);

  const files = findJsonFiles(path.resolve(__dirname, DATA_DIR));
  console.log(`📂 ${files.length} fichier(s) trouvé(s)\n`);

  const allQuestions = {};
  let total = 0;

  for (const file of files) {
    try {
      const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
      const qs   = raw.questions ?? [];
      for (const q of qs) {
        if (!q.id || !q.text || !Array.isArray(q.options)) {
          console.warn(`  ⚠️  Question ignorée (champs manquants) dans ${path.basename(file)}`);
          continue;
        }
        // Clé unique = id de la question
        allQuestions[q.id] = {
          id:         q.id,
          text:       q.text,
          options:    q.options,
          correct:    q.correct ?? 0,
          xp:         q.xp     ?? 10,
          difficulte: q.difficulte ?? 'normal',
        };
        total++;
      }
      console.log(`  ✅ ${path.basename(file)} → ${qs.length} question(s)`);
    } catch (e) {
      console.error(`  ❌ Erreur lecture ${path.basename(file)} :`, e.message);
    }
  }

  console.log(`\n📤 Upload de ${total} questions vers RTDB...`);
  await db.ref(`daily_questions/${TARGET_DATE}`).set(allQuestions);
  console.log(`✅ Upload terminé ! (${total} questions pour ${TARGET_DATE})\n`);
  process.exit(0);
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });