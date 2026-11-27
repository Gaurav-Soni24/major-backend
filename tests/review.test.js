const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let api;
let A;
let B;
before(async () => {
  await h.startDb();
  h.installGoogleDouble();
  api = h.getApp();
});
after(async () => {
  h.resetDoubles();
  await h.stopDb();
});
beforeEach(async () => {
  await h.clearDb();
  h.installAiDouble(h.perfectAiGrader());
  A = await h.registerTeacher(api, 'a@example.com');
  B = await h.registerTeacher(api, 'b@example.com');
});

// Creates a quiz for A with: alice (100%), bob (flagged, 20%), carol (in progress)
const seed = async () => {
  const quizId = await h.createQuiz(api, A, { passingScore: 50 });
  const pub = await h.publicQuiz(api, quizId);
  const alice = await h.beginAttempt(api, quizId, 'alice@example.com');
  await api.post('/api/submissions').set(alice.headers).send({
    submissionId: alice.submissionId,
    answers: h.answersFor(pub, { 0: 'Paris', 1: ['2', '3'], 2: '5', 3: 'x', 4: 'y' }),
  });
  const bob = await h.beginAttempt(api, quizId, 'bob@example.com');
  await api.post('/api/submissions/flag').set(bob.headers).send({ submissionId: bob.submissionId, reason: 'Face not visible', imageBase64: 'data:image/jpeg;base64,/9j/AAAA' });
  await api.post('/api/submissions').set(bob.headers).send({ submissionId: bob.submissionId, answers: h.answersFor(pub, { 0: 'Paris', 2: '5' }) });
  const carol = await h.beginAttempt(api, quizId, 'carol@example.com');
  return { quizId, pub, alice, bob, carol };
};

test('submission list: pagination, filters, search, sort, summary, no flagged images, no token hash', async () => {
  const { quizId } = await seed();
  const res = await api.get(`/api/submissions/quiz/${quizId}`).set(A.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.submissions.length, 3);
  assert.deepEqual(res.body.pagination, { page: 1, limit: 20, total: 3, pages: 1 });
  assert.deepEqual(res.body.summary, { count: 3, submitted: 2, inProgress: 1, flagged: 1, avgPercentage: 60, passRate: 50 });
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('imageBase64') && !raw.includes('flaggedImages'), 'no flagged images in the list');
  assert.ok(!raw.includes('attemptTokenHash'));
  assert.equal(res.body.submissions[0].userDetails.email, 'carol@example.com', 'newest first');

  const page = await api.get(`/api/submissions/quiz/${quizId}?limit=2&page=2`).set(A.auth);
  assert.equal(page.body.submissions.length, 1);
  assert.equal(page.body.pagination.pages, 2);
  const flagged = await api.get(`/api/submissions/quiz/${quizId}?flagged=true`).set(A.auth);
  assert.deepEqual(flagged.body.submissions.map((s) => s.userDetails.email), ['bob@example.com']);
  const prog = await api.get(`/api/submissions/quiz/${quizId}?status=in-progress`).set(A.auth);
  assert.deepEqual(prog.body.submissions.map((s) => s.userDetails.email), ['carol@example.com']);
  const search = await api.get(`/api/submissions/quiz/${quizId}?search=ALI`).set(A.auth);
  assert.deepEqual(search.body.submissions.map((s) => s.userDetails.email), ['alice@example.com']);
  const byScore = await api.get(`/api/submissions/quiz/${quizId}?status=submitted&sort=score`).set(A.auth);
  assert.deepEqual(byScore.body.submissions.map((s) => s.userDetails.email), ['alice@example.com', 'bob@example.com']);
  assert.equal((await api.get(`/api/submissions/quiz/${quizId}?status=weird`).set(A.auth)).status, 400);
});

test('submission list: only the quiz owner (403, same answer for unknown quizzes)', async () => {
  const { quizId } = await seed();
  const foreign = await api.get(`/api/submissions/quiz/${quizId}`).set(B.auth);
  const unknown = await api.get(`/api/submissions/quiz/${new h.mongoose.Types.ObjectId()}`).set(B.auth);
  assert.equal(foreign.status, 403);
  assert.equal(unknown.status, 403);
  assert.equal(foreign.body.code, 'FORBIDDEN');
  assert.equal((await api.get(`/api/submissions/quiz/${quizId}`)).status, 401);
});

test('S1 regression: details has an owner check; the owner gets images and a trimmed quiz', async () => {
  const { bob, quizId } = await seed();
  const foreign = await api.get(`/api/submissions/details/${bob.submissionId}`).set(B.auth);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.code, 'FORBIDDEN');
  assert.ok(!JSON.stringify(foreign.body).includes('imageBase64'));
  assert.ok(!JSON.stringify(foreign.body).includes('Paris'));
  assert.equal((await api.get(`/api/submissions/details/${bob.submissionId}`)).status, 401);
  assert.equal((await api.get(`/api/submissions/details/${new h.mongoose.Types.ObjectId()}`).set(A.auth)).status, 404);
  assert.equal((await api.get('/api/submissions/details/not-an-id').set(A.auth)).status, 400);

  const own = await api.get(`/api/submissions/details/${bob.submissionId}`).set(A.auth);
  assert.equal(own.status, 200);
  assert.equal(own.body.submission.antiCheat.flaggedImages.length, 1);
  assert.equal(own.body.submission.antiCheat.flaggedImages[0].reason, 'Face not visible');
  assert.deepEqual(Object.keys(own.body.quiz).sort(), ['_id', 'antiCheatSettings', 'passingScore', 'timeLimit', 'title']);
  assert.equal(own.body.quiz._id, quizId);
  assert.equal(own.body.submission.attemptTokenHash, undefined);
  assert.ok(!JSON.stringify(own.body).includes('"questions":[{"type"'), 'quiz questions (with answers) are not embedded');
});

test('manual grade and delete are owner only', async () => {
  const { alice, bob } = await seed();
  const patch = (id, who, body) => api.patch(`/api/submissions/details/${id}/grade`).set(who.auth).send(body);
  assert.equal((await patch(alice.submissionId, B, { questionIndex: 0, marksObtained: 0 })).status, 403);
  assert.equal((await api.delete(`/api/submissions/details/${alice.submissionId}`).set(B.auth)).status, 403);
  assert.equal(await h.Submission.countDocuments({ _id: alice.submissionId }), 1);

  const g = await patch(alice.submissionId, A, { questionIndex: 0, marksObtained: 1 });
  assert.equal(g.status, 200);
  assert.equal(g.body.status, 'graded');
  assert.equal(g.body.score.obtainedMarks, 19);

  // in-progress attempts cannot be graded
  const { carol } = await (async () => ({ carol: await h.Submission.findOne({ 'userDetails.email': 'carol@example.com' }) }))();
  assert.equal((await patch(carol._id, A, { questionIndex: 0, marksObtained: 1 })).status, 409);

  // delete lets the student retry
  const del = await api.delete(`/api/submissions/details/${bob.submissionId}`).set(A.auth);
  assert.equal(del.status, 200);
  assert.equal(await h.Submission.countDocuments({ _id: bob.submissionId }), 0);
  const quizId = String((await h.Quiz.findOne({}))._id);
  const retry = await h.beginAttempt(api, quizId, 'bob@example.com');
  assert.equal(retry.start.resumed, false);
});

test('S2/S5 regression: the old unauthenticated shapes no longer work', async () => {
  const { alice } = await seed();
  // legacy start-attempt without a token and legacy flag/submit without an attempt token
  const quizId = String((await h.Quiz.findOne({}))._id);
  const noTok = await api.post('/api/submissions/start-attempt').send({ quizId, userDetails: { email: 'x@example.com', name: 'x' } });
  assert.equal(noTok.status, 401);
  const flag = await api.post('/api/submissions/flag').send({ submissionId: alice.submissionId, reason: 'x' });
  assert.equal(flag.status, 401);
  const submit = await api.post('/api/submissions').send({ submissionId: alice.submissionId, answers: [] });
  assert.equal(submit.status, 401);
  const lookup = await api.get('/api/submissions/student/alice@example.com');
  assert.equal(lookup.status, 401);
  assert.ok(!JSON.stringify(lookup.body).includes('Sample quiz'));
});
