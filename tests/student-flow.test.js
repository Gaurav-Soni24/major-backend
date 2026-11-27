const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let api;
let T;
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
  T = await h.registerTeacher(api, 'teacher@example.com');
});

const studentAuth = (token) => ({ Authorization: `Student ${token}` });

test('verify-google: new student gets a studentToken; unverified or invalid credentials are refused', async () => {
  const quizId = await h.createQuiz(api, T);
  const ok = await h.studentLogin(api, quizId, 'new@example.com', 'New Student');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'new');
  assert.equal(ok.body.email, 'new@example.com');
  assert.ok(ok.body.studentToken);
  assert.equal(ok.body.submissionId, undefined);

  const unverified = await api.post('/api/submissions/verify-google').send({ quizId, credential: 'g:u@example.com:U:unverified' });
  assert.equal(unverified.status, 401);
  const bad = await api.post('/api/submissions/verify-google').send({ quizId, credential: 'nonsense' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'UNAUTHENTICATED');
  assert.equal((await api.post('/api/submissions/verify-google').send({ credential: 'g:a@b.co' })).status, 400);
  assert.equal((await api.post('/api/submissions/verify-google').send({ quizId: new h.mongoose.Types.ObjectId().toString(), credential: 'g:a@b.co' })).status, 404);

  const portal = await api.post('/api/submissions/verify-google').send({ quizId: 'portal-auth', credential: 'g:p@example.com:Portal' });
  assert.equal(portal.status, 200);
  assert.ok(portal.body.studentToken);
});

test('start-attempt requires a student token and ignores the email/name in the body', async () => {
  const quizId = await h.createQuiz(api, T);
  const noToken = await api.post('/api/submissions/start-attempt').send({ quizId, userDetails: { email: 'victim@example.com', name: 'x' } });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.code, 'STUDENT_TOKEN_INVALID');
  const teacherToken = await api.post('/api/submissions/start-attempt').set(T.auth).send({ quizId });
  assert.equal(teacherToken.status, 401);

  const v = await h.studentLogin(api, quizId, 'real@example.com', 'Real Name');
  const res = await h.startAttempt(api, quizId, v.body, { userDetails: { email: 'victim@example.com', name: 'Spoofed' } });
  assert.equal(res.status, 200);
  const sub = await h.Submission.findById(res.body.submissionId);
  assert.equal(sub.userDetails.email, 'real@example.com');
  assert.equal(sub.userDetails.name, 'Real Name');
  assert.equal(await h.Submission.countDocuments({ 'userDetails.email': 'victim@example.com' }), 0);
  // the response matches the contract
  assert.equal(res.body.resumed, false);
  assert.ok(res.body.attemptToken && res.body.startedAt && res.body.serverTime);
  assert.equal(new Date(res.body.deadlineAt) - new Date(res.body.startedAt), 30 * 60000);
  assert.deepEqual(res.body.answers, []);
  assert.deepEqual(res.body.antiCheat, { tabSwitches: 0, webcamStrikes: 0, copyPasteAttempts: 0 });
  // only the hash is stored
  const withHash = await h.Submission.findById(sub._id).select('+attemptTokenHash');
  assert.notEqual(withHash.attemptTokenHash, res.body.attemptToken);
  assert.match(withHash.attemptTokenHash, /^[a-f0-9]{64}$/);
});

test('start-attempt: unpublished quiz is refused, untimed quiz has no deadline', async () => {
  const draft = await h.createQuiz(api, T, {}, { publish: false });
  const v = await h.studentLogin(api, draft);
  const res = await h.startAttempt(api, draft, v.body);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'QUIZ_NOT_PUBLISHED');

  const untimed = await h.createQuiz(api, T, { timeLimit: null });
  const a = await h.beginAttempt(api, untimed, 'untimed@example.com');
  assert.equal(a.start.deadlineAt, null);
  const save = await api.put(`/api/submissions/${a.submissionId}/answers`).set(a.headers).send({ answers: [] });
  assert.equal(save.status, 200);
  assert.equal(save.body.remainingSeconds, null);
});

test('quiz password: wrong/missing refused; bcrypt hash accepted; legacy plaintext accepted once and re-hashed', async () => {
  const quizId = await h.createQuiz(api, T, { password: 'open-sesame' });
  const stored = await h.Quiz.findById(quizId);
  assert.match(stored.password, /^\$2[aby]\$/);

  const v = await h.studentLogin(api, quizId, 'pw@example.com');
  const missing = await h.startAttempt(api, quizId, v.body);
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, 'WRONG_PASSWORD');
  assert.equal((await h.startAttempt(api, quizId, v.body, { password: 'nope' })).status, 401);
  assert.equal(await h.Submission.countDocuments({}), 0);
  assert.equal((await h.startAttempt(api, quizId, v.body, { password: 'open-sesame' })).status, 200);

  // legacy quiz with a plaintext password
  const legacyId = await h.createQuiz(api, T, { title: 'Legacy pw quiz' });
  await h.Quiz.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(legacyId) }, { $set: { password: 'plain123' } });
  const v2 = await h.studentLogin(api, legacyId, 'legacy@example.com');
  assert.equal((await h.startAttempt(api, legacyId, v2.body, { password: 'wrong' })).status, 401);
  assert.equal((await h.Quiz.findById(legacyId)).password, 'plain123', 'a wrong guess does not rehash');
  assert.equal((await h.startAttempt(api, legacyId, v2.body, { password: 'plain123' })).status, 200);
  const rehashed = await h.Quiz.findById(legacyId);
  assert.match(rehashed.password, /^\$2[aby]\$/);
  // the hash works for the next student
  const v3 = await h.studentLogin(api, legacyId, 'legacy2@example.com');
  assert.equal((await h.startAttempt(api, legacyId, v3.body, { password: 'plain123' })).status, 200);
});

test('custom fields: required, typed, size-capped and stored on the submission', async () => {
  const quizId = await h.createQuiz(api, T, { customFields: [{ name: 'Roll No', type: 'number' }, { name: 'Class', type: 'text' }] });
  const v = await h.studentLogin(api, quizId, 'cf@example.com');
  const missing = await h.startAttempt(api, quizId, v.body, { customData: { Class: '12A' } });
  assert.equal(missing.status, 400);
  assert.ok(missing.body.details.some((d) => d.field === 'customData.Roll No'));
  assert.equal((await h.startAttempt(api, quizId, v.body, { customData: { 'Roll No': 'abc', Class: '12A' } })).status, 400);
  assert.equal((await h.startAttempt(api, quizId, v.body, { customData: { 'Roll No': 5, Class: 'x'.repeat(201) } })).status, 400);
  assert.equal((await h.startAttempt(api, quizId, v.body, { customData: { 'Roll No': 5, Class: { $ne: 1 } } })).status, 400);
  const ok = await h.startAttempt(api, quizId, v.body, { customData: { 'Roll No': '42', Class: '12A', Extra: 'dropped' } });
  assert.equal(ok.status, 200);
  const sub = await h.Submission.findById(ok.body.submissionId);
  assert.deepEqual(sub.userDetails.customData, { 'Roll No': '42', Class: '12A' });
});

test('full flow: start -> autosave -> reload/resume -> flag -> submit -> result', async () => {
  const quizId = await h.createQuiz(api, T);
  const pub = await h.publicQuiz(api, quizId);
  const a = await h.beginAttempt(api, quizId, 'flow@example.com');

  // autosave two answers + counters
  const save1 = await api.put(`/api/submissions/${a.submissionId}/answers`).set(a.headers).send({
    answers: h.answersFor(pub, { 0: 'Paris', 3: 'Mass attracts mass' }),
    antiCheat: { tabSwitches: 2, webcamStrikes: 1, copyPasteAttempts: 0 },
  });
  assert.equal(save1.status, 200);
  assert.ok(save1.body.savedAt && save1.body.serverTime);
  assert.ok(save1.body.remainingSeconds > 1790 && save1.body.remainingSeconds <= 1800);
  // merge by questionId: a later save adds one answer and overwrites another; counters never go down
  const save2 = await api.put(`/api/submissions/${a.submissionId}/answers`).set(a.headers).send({
    answers: h.answersFor(pub, { 2: '5', 0: 'Rome' }),
    antiCheat: { tabSwitches: 1, webcamStrikes: 3 },
  });
  assert.equal(save2.status, 200);
  const stored = await h.Submission.findById(a.submissionId);
  assert.equal(stored.antiCheat.tabSwitches, 2);
  assert.equal(stored.antiCheat.webcamStrikes, 3);

  // the student reloads: verify-google reports in-progress, start-attempt resumes with saved answers and a NEW token
  const v = await h.studentLogin(api, quizId, 'flow@example.com');
  assert.equal(v.status, 200);
  assert.equal(v.body.status, 'in-progress');
  assert.equal(v.body.submissionId, a.submissionId);
  const resumed = await h.startAttempt(api, quizId, v.body);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.resumed, true);
  assert.equal(resumed.body.submissionId, a.submissionId);
  assert.notEqual(resumed.body.attemptToken, a.attemptToken);
  const saved = Object.fromEntries(resumed.body.answers.map((x) => [x.questionId, x.userAnswer]));
  assert.equal(saved[pub.questions[0]._id], 'Rome');
  assert.equal(saved[pub.questions[2]._id], '5');
  assert.equal(saved[pub.questions[3]._id], 'Mass attracts mass');
  assert.equal(resumed.body.answers.length, 3);
  assert.equal(resumed.body.antiCheat.tabSwitches, 2);
  assert.equal(resumed.body.startedAt, a.start.startedAt, 'timer is not reset by a reload');
  assert.equal(resumed.body.deadlineAt, a.start.deadlineAt);
  assert.equal((await h.Submission.findById(a.submissionId)).antiCheat.reloads, 1);
  assert.equal(await h.Submission.countDocuments({}), 1);

  // the old token is dead, the new one works
  const old = await api.put(`/api/submissions/${a.submissionId}/answers`).set(a.headers).send({ answers: [] });
  assert.equal(old.status, 403);
  const headers = { 'X-Attempt-Token': resumed.body.attemptToken };

  // flag
  const flag = await api.post('/api/submissions/flag').set(headers).send({ submissionId: a.submissionId, reason: 'Face not visible', imageBase64: 'data:image/jpeg;base64,/9j/AAAA' });
  assert.equal(flag.status, 200);
  assert.equal(flag.body.stored, true);
  assert.equal((await h.Submission.findById(a.submissionId)).antiCheat.isFlagged, true);

  // result is not available while in progress
  const early = await api.get(`/api/submissions/${a.submissionId}/result`).set(headers);
  assert.equal(early.status, 409);

  // submit with the remaining answers
  const sub = await api.post('/api/submissions').set(headers).send({
    submissionId: a.submissionId,
    answers: h.answersFor(pub, { 0: 'Paris', 1: ['3', '2'], 4: 'function add(a,b){return a+b}' }),
    antiCheat: { tabSwitches: 2, webcamStrikes: 3, copyPasteAttempts: 1 },
  });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, 'submitted');
  assert.deepEqual(sub.body.score, { totalMarks: 20, obtainedMarks: 20, percentage: 100 });
  assert.equal(sub.body.passed, true);
  assert.equal(sub.body.passingScore, 50);
  assert.equal(sub.body.needsReview, false);
  assert.equal(sub.body.result.questions.length, 5);
  assert.equal(sub.body.result.questions[0].correctAnswer, 'Paris');
  const final = await h.Submission.findById(a.submissionId).select('+attemptTokenHash');
  assert.equal(final.antiCheat.copyPasteAttempts, 1);
  assert.equal(final.late, false);

  // result survives refresh via attempt token or via the student token of the same email
  const r1 = await api.get(`/api/submissions/${a.submissionId}/result`).set(headers);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body.score, sub.body.score);
  const r2 = await api.get(`/api/submissions/${a.submissionId}/result`).set(studentAuth(v.body.studentToken));
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body.score, sub.body.score);

  // no further changes: autosave 409, flag 409, new start 403, verify 403
  assert.equal((await api.put(`/api/submissions/${a.submissionId}/answers`).set(headers).send({ answers: [] })).body.code, 'ALREADY_SUBMITTED');
  assert.equal((await api.post('/api/submissions/flag').set(headers).send({ submissionId: a.submissionId, reason: 'late' })).status, 409);
  assert.equal((await h.startAttempt(api, quizId, v.body)).body.code, 'ALREADY_SUBMITTED');
  const again = await h.studentLogin(api, quizId, 'flow@example.com');
  assert.equal(again.status, 403);
  assert.equal(again.body.code, 'ALREADY_SUBMITTED');
});

test('attempt token: missing 401, wrong 403, unknown id 403, another student cannot touch an attempt', async () => {
  const quizId = await h.createQuiz(api, T);
  const a = await h.beginAttempt(api, quizId, 'alice@example.com');
  const b = await h.beginAttempt(api, quizId, 'bob@example.com');

  const calls = (sid, headers) => [
    api.put(`/api/submissions/${sid}/answers`).set(headers).send({ answers: [] }),
    api.post('/api/submissions/flag').set(headers).send({ submissionId: sid, reason: 'x' }),
    api.post('/api/submissions').set(headers).send({ submissionId: sid }),
    api.get(`/api/submissions/${sid}/result`).set(headers),
  ];
  for (const r of await Promise.all(calls(a.submissionId, {}))) {
    assert.equal(r.status, 401, 'no token');
    assert.equal(r.body.code, 'ATTEMPT_TOKEN_INVALID');
  }
  for (const r of await Promise.all(calls(a.submissionId, { 'X-Attempt-Token': 'f'.repeat(64) }))) assert.equal(r.status, 403, 'wrong token');
  // Bob's valid token against Alice's attempt
  for (const r of await Promise.all(calls(a.submissionId, b.headers))) {
    assert.equal(r.status, 403, "another student's token");
    assert.equal(r.body.code, 'ATTEMPT_TOKEN_INVALID');
  }
  const ghost = new h.mongoose.Types.ObjectId().toString();
  for (const r of await Promise.all(calls(ghost, b.headers))) assert.equal(r.status, 403, 'unknown id looks the same as a wrong token');
  // Bob's student token cannot read Alice's result either
  assert.equal((await api.get(`/api/submissions/${a.submissionId}/result`).set(studentAuth(b.studentToken))).status, 403);

  // nothing of Alice's changed
  const alice = await h.Submission.findById(a.submissionId);
  assert.equal(alice.status, 'in-progress');
  assert.equal(alice.antiCheat.flagCount, 0);
});

test('student/:email requires a matching student token (S2)', async () => {
  const quizId = await h.createQuiz(api, T);
  const a = await h.beginAttempt(api, quizId, 'alice@example.com');
  const pub = await h.publicQuiz(api, quizId);
  await api.post('/api/submissions').set(a.headers).send({ submissionId: a.submissionId, answers: h.answersFor(pub, { 0: 'Paris' }) });
  const bobToken = (await h.studentLogin(api, quizId, 'bob@example.com')).body.studentToken;

  const anon = await api.get('/api/submissions/student/alice@example.com');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.code, 'STUDENT_TOKEN_INVALID');
  const wrong = await api.get('/api/submissions/student/alice@example.com').set(studentAuth(bobToken));
  assert.equal(wrong.status, 403);
  assert.equal((await api.get('/api/submissions/student/alice@example.com').set(T.auth)).status, 401, 'a teacher token is not a student token');

  const ok = await api.get('/api/submissions/student/Alice@Example.com').set(studentAuth(a.studentToken));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.submissions.length, 1);
  const row = ok.body.submissions[0];
  assert.equal(row.quizTitle, 'Sample quiz');
  assert.equal(row.status, 'submitted');
  assert.equal(row.score.obtainedMarks, 2);
  assert.equal(typeof row.passed, 'boolean');
  assert.equal(row.answers, undefined);
  assert.equal(row.questions, undefined);
  assert.equal(row.antiCheat, undefined);
  const empty = await api.get('/api/submissions/student/bob@example.com').set(studentAuth(bobToken));
  assert.deepEqual(empty.body.submissions, []);
});

test('concurrent start-attempt calls create exactly one submission', async () => {
  const quizId = await h.createQuiz(api, T);
  const v = await h.studentLogin(api, quizId, 'race@example.com');
  const results = await Promise.all(Array.from({ length: 6 }, () => h.startAttempt(api, quizId, v.body)));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(await h.Submission.countDocuments({ quizId }), 1);
  assert.equal(new Set(results.map((r) => r.body.submissionId)).size, 1);
  assert.ok(results.filter((r) => r.body.resumed === false).length <= 1);
});

test('flag: size cap, base64 check, 20 stored max with the rest counted, reason length', async () => {
  const quizId = await h.createQuiz(api, T);
  const a = await h.beginAttempt(api, quizId, 'flagger@example.com');
  const flag = (body) => api.post('/api/submissions/flag').set(a.headers).send({ submissionId: a.submissionId, ...body });

  const big = Buffer.alloc(400 * 1024 + 10, 1).toString('base64');
  const tooBig = await flag({ reason: 'x', imageBase64: big });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await flag({ reason: 'x', imageBase64: 'not base64 !!!' })).status, 400);
  assert.equal((await flag({ reason: 'x'.repeat(121) })).status, 400);
  const justOk = Buffer.alloc(400 * 1024, 1).toString('base64');
  assert.equal((await flag({ reason: 'exactly at the cap', imageBase64: justOk })).status, 200);

  for (let i = 0; i < 24; i++) assert.equal((await flag({ reason: `r${i}`, imageBase64: 'AAAA' })).status, 200);
  const sub = await h.Submission.findById(a.submissionId);
  assert.equal(sub.antiCheat.flaggedImages.length, 20);
  assert.equal(sub.antiCheat.flagCount, 25);
  assert.equal(sub.antiCheat.isFlagged, true);
});

test('autosave validates answer shape per question type and ignores unknown questions', async () => {
  const quizId = await h.createQuiz(api, T);
  const pub = await h.publicQuiz(api, quizId);
  const a = await h.beginAttempt(api, quizId, 'shape@example.com');
  const save = (answers) => api.put(`/api/submissions/${a.submissionId}/answers`).set(a.headers).send({ answers });

  assert.equal((await save('nope')).status, 400);
  assert.equal((await save([{ questionId: pub.questions[0]._id, userAnswer: ['array-for-single'] }])).status, 400);
  assert.equal((await save([{ questionId: pub.questions[1]._id, userAnswer: 'string-for-multiple' }])).status, 400);
  assert.equal((await save([{ questionId: pub.questions[3]._id, userAnswer: 'x'.repeat(10001) }])).status, 400);
  assert.equal((await save([{ questionId: pub.questions[0]._id, userAnswer: { $ne: 1 } }])).status, 400);
  assert.equal((await save(Array.from({ length: 101 }, () => ({ questionId: pub.questions[0]._id, userAnswer: 'a' })))).status, 400);
  const unknown = await save([{ questionId: new h.mongoose.Types.ObjectId().toString(), userAnswer: 'x' }, { questionId: pub.questions[0]._id, userAnswer: 'Paris' }]);
  assert.equal(unknown.status, 200);
  const sub = await h.Submission.findById(a.submissionId);
  assert.equal(sub.questions.length, 5, 'no entries were invented for unknown questions');
  assert.equal(sub.questions[0].userAnswer, 'Paris');
  // clearing an answer
  await save([{ questionId: pub.questions[0]._id, userAnswer: '' }]);
  assert.equal((await h.Submission.findById(a.submissionId)).questions[0].userAnswer, null);
});

test('legacy clients: answers keyed by originalIndex still grade', async () => {
  const quizId = await h.createQuiz(api, T);
  const a = await h.beginAttempt(api, quizId, 'legacyclient@example.com');
  const res = await api.post('/api/submissions').set(a.headers).send({
    submissionId: a.submissionId,
    answers: [{ originalIndex: 0, userAnswer: 'Paris' }, { questionId: 2, userAnswer: '5' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.score.obtainedMarks, 4);
});
