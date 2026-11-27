const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { run } = require('../scripts/migrate');

before(async () => {
  await h.startDb();
});
after(async () => {
  await h.stopDb();
});

test('migrate: reports duplicates, keeps the most advanced, hashes passwords, back-fills deadlines, builds indexes; idempotent; --dry changes nothing', async () => {
  const oid = () => new h.mongoose.Types.ObjectId();
  // simulate a legacy database: no unique index yet
  await h.Submission.collection.dropIndexes();
  const teacher = oid();
  const quiz = await h.Quiz.collection.insertOne({ userId: teacher, title: 'Legacy', isPublic: true, timeLimit: 30, passingScore: 60, password: 'plain-pw', questions: [] });
  const noPw = await h.Quiz.collection.insertOne({ userId: teacher, title: 'No password', isPublic: true, password: '', questions: [] });
  const qid = quiz.insertedId;
  const t0 = new Date('2026-01-01T10:00:00Z');
  const sub = (email, status, pct, extra = {}) => ({
    quizId: qid, userDetails: { name: 'n', email }, status, startedAt: t0, score: { totalMarks: 10, obtainedMarks: pct / 10, percentage: pct }, ...extra,
  });
  await h.Submission.collection.insertMany([
    sub('dup@example.com', 'in-progress', 0),
    sub('Dup@Example.com', 'submitted', 40, { submittedAt: t0 }),
    sub('dup@example.com', 'submitted', 70, { submittedAt: t0 }),
    sub('solo@example.com', 'in-progress', 0),
  ]);

  const dry = await run({ dry: true, log: () => {} });
  assert.equal(dry.dry, true);
  assert.equal(dry.emailsLowercased, 1);
  assert.equal(dry.duplicateGroups, 1);
  assert.equal(dry.duplicatesRemoved, 2, 'reported, not deleted');
  assert.equal(await h.Submission.countDocuments({}), 4);
  assert.equal((await h.Quiz.collection.findOne({ _id: qid })).password, 'plain-pw');
  assert.equal(dry.passwordsHashed, 1);
  assert.equal(dry.deadlinesBackfilled, 2);

  const real = await run({ log: () => {} });
  assert.equal(real.emailsLowercased, 1);
  assert.equal(real.duplicateGroups, 1);
  assert.equal(real.duplicatesRemoved, 2);
  assert.equal(real.passwordsHashed, 1);
  assert.equal(real.deadlinesBackfilled, 1, 'the in-progress duplicate was removed first');
  assert.ok(real.indexesBuilt.includes('Submission'));

  const rows = await h.Submission.collection.find({ quizId: qid }).toArray();
  assert.equal(rows.length, 2);
  const kept = rows.find((r) => r.userDetails.email === 'dup@example.com');
  assert.equal(kept.status, 'submitted');
  assert.equal(kept.score.percentage, 70, 'the most advanced / highest-scoring one is kept');
  const solo = rows.find((r) => r.userDetails.email === 'solo@example.com');
  assert.equal(new Date(solo.deadlineAt).getTime(), t0.getTime() + 30 * 60000);
  assert.match((await h.Quiz.collection.findOne({ _id: qid })).password, /^\$2[aby]\$/);
  assert.equal((await h.Quiz.collection.findOne({ _id: noPw.insertedId })).password, '');

  // the unique index now exists and is enforced
  const idx = await h.Submission.collection.indexes();
  assert.ok(idx.some((i) => i.unique && i.key.quizId === 1 && i.key['userDetails.email'] === 1));
  await assert.rejects(() => h.Submission.collection.insertOne(sub('solo@example.com', 'in-progress', 0)), /duplicate key/);

  // idempotent
  const again = await run({ log: () => {} });
  assert.equal(again.duplicateGroups, 0);
  assert.equal(again.duplicatesRemoved, 0);
  assert.equal(again.passwordsHashed, 0);
  assert.equal(again.emailsLowercased, 0);
  assert.equal(again.deadlinesBackfilled, 0);
  assert.equal(await h.Submission.countDocuments({}), 2);
});
