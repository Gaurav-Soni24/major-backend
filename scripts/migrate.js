/**
 * Idempotent migration for Quizify 2.0.
 *
 *   npm run migrate            apply
 *   npm run migrate -- --dry   report only, change nothing
 *
 * Steps:
 *  1. Lowercase submission emails.
 *  2. Find duplicate (quizId, email) submissions, keep the most advanced one, delete the rest.
 *  3. Back-fill `deadlineAt` on in-progress attempts of timed quizzes (so expiry can be enforced).
 *  4. Hash plaintext quiz passwords with bcrypt.
 *  5. Build the new indexes (including the unique (quizId, email) index).
 */
const mongoose = require('mongoose');
const Quiz = require('../models/Quiz');
const Submission = require('../models/Submission');
const User = require('../models/User');
const { isHashed, hashQuizPassword } = require('../services/quizPassword');

const RANK = { graded: 3, submitted: 2, 'in-progress': 1, abandoned: 0 };

const better = (a, b) => {
  const ra = RANK[a.status] ?? 0;
  const rb = RANK[b.status] ?? 0;
  if (ra !== rb) return ra > rb ? a : b;
  const pa = (a.score && a.score.percentage) || 0;
  const pb = (b.score && b.score.percentage) || 0;
  if (pa !== pb) return pa > pb ? a : b;
  const ta = new Date(a.submittedAt || a.startedAt || 0).getTime();
  const tb = new Date(b.submittedAt || b.startedAt || 0).getTime();
  return ta >= tb ? a : b;
};

const run = async ({ dry = false, log = console.log } = {}) => {
  const report = { dry, emailsLowercased: 0, duplicateGroups: 0, duplicatesRemoved: 0, deadlinesBackfilled: 0, passwordsHashed: 0, indexesBuilt: [] };

  // 1. emails
  const mixed = await Submission.find({ 'userDetails.email': { $regex: /[A-Z]/ } }).select('userDetails.email').lean();
  report.emailsLowercased = mixed.length;
  if (!dry) {
    for (const s of mixed) await Submission.updateOne({ _id: s._id }, { $set: { 'userDetails.email': s.userDetails.email.toLowerCase() } });
  }

  // 2. duplicates (computed on lowercase emails so step 1 cannot create new collisions)
  const groups = await Submission.aggregate([
    { $group: { _id: { quizId: '$quizId', email: { $toLower: '$userDetails.email' } }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  report.duplicateGroups = groups.length;
  for (const g of groups) {
    const docs = await Submission.find({ _id: { $in: g.ids } }).select('-antiCheat.flaggedImages').lean();
    const keep = docs.reduce((best, d) => (best ? better(best, d) : d), null);
    const drop = docs.filter((d) => String(d._id) !== String(keep._id));
    report.duplicatesRemoved += drop.length;
    log(`duplicate: quiz ${g._id.quizId} ${g._id.email}: keeping ${keep._id} (${keep.status}), removing ${drop.length}`);
    if (!dry) await Submission.deleteMany({ _id: { $in: drop.map((d) => d._id) } });
  }

  // 3. deadlines for in-progress attempts of timed quizzes
  const open = await Submission.find({ status: 'in-progress', deadlineAt: null }).select('quizId startedAt').lean();
  if (open.length) {
    const quizzes = await Quiz.find({ _id: { $in: [...new Set(open.map((s) => String(s.quizId)))] } }).select('timeLimit').lean();
    const limit = new Map(quizzes.map((q) => [String(q._id), q.timeLimit]));
    for (const s of open) {
      const mins = limit.get(String(s.quizId));
      if (!mins) continue;
      report.deadlinesBackfilled++;
      if (!dry) await Submission.updateOne({ _id: s._id }, { $set: { deadlineAt: new Date(new Date(s.startedAt).getTime() + mins * 60000) } });
    }
  }

  // 4. plaintext quiz passwords
  const withPw = await Quiz.find({ password: { $nin: ['', null] } }).select('password').lean();
  for (const q of withPw) {
    if (isHashed(q.password)) continue;
    report.passwordsHashed++;
    if (!dry) await Quiz.updateOne({ _id: q._id, password: q.password }, { $set: { password: await hashQuizPassword(q.password) } });
  }

  // 5. indexes (after duplicates are gone, so the unique index can be built)
  if (!dry) {
    for (const M of [User, Quiz, Submission]) {
      await M.createIndexes();
      report.indexesBuilt.push(M.modelName);
    }
  }

  log(JSON.stringify(report, null, 2));
  return report;
};

module.exports = { run };

if (require.main === module) {
  require('dotenv').config();
  const dry = process.argv.includes('--dry');
  (async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
    await mongoose.connect(process.env.MONGO_URI);
    console.log(dry ? 'Dry run: nothing will be changed.' : 'Applying migration...');
    await run({ dry });
  })()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      await mongoose.disconnect().catch(() => {});
      process.exit(1);
    });
}
