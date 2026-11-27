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

const create = (body, who = A) => api.post('/api/quizzes/create').set(who.auth).send(body);
const detailFor = (res, field) => (res.body.details || []).some((d) => d.field.startsWith(field));

test('create: valid quiz is stored, originalIndex is assigned, password is hashed and never returned', async () => {
  const res = await create(h.quizPayload({ password: 'secret' }));
  assert.equal(res.status, 201);
  const stored = await h.Quiz.findById(res.body.quizId);
  assert.deepEqual(stored.questions.map((q) => q.originalIndex), [0, 1, 2, 3, 4]);
  assert.match(stored.password, /^\$2[aby]\$/);
  const got = await api.get(`/api/quizzes/${res.body.quizId}`).set(A.auth);
  assert.equal(got.status, 200);
  assert.equal(got.body.quiz.password, undefined);
  assert.equal(got.body.quiz.hasPassword, true);
  assert.ok(got.body.quiz.questions[0].options.some((o) => o.isCorrect), 'owner view includes correct answers');
});

test('create: every validation rule in the contract is enforced', async () => {
  const cases = [
    ['short title', { title: 'ab' }, 'title'],
    ['long title', { title: 'x'.repeat(121) }, 'title'],
    ['long description', { description: 'x'.repeat(1001) }, 'description'],
    ['too many instructions', { instructions: Array(21).fill('a') }, 'instructions'],
    ['long instruction', { instructions: ['x'.repeat(301)] }, 'instructions[0]'],
    ['timeLimit 0', { timeLimit: 0 }, 'timeLimit'],
    ['timeLimit 601', { timeLimit: 601 }, 'timeLimit'],
    ['timeLimit fraction', { timeLimit: 1.5 }, 'timeLimit'],
    ['passingScore 0', { passingScore: 0 }, 'passingScore'],
    ['passingScore 101', { passingScore: 101 }, 'passingScore'],
    ['6 custom fields', { customFields: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, type: 'text' })) }, 'customFields'],
    ['bad custom field type', { customFields: [{ name: 'roll', type: 'date' }] }, 'customFields[0].type'],
    ['custom field name with dot', { customFields: [{ name: 'a.b', type: 'text' }] }, 'customFields[0].name'],
    ['long password', { password: 'x'.repeat(65) }, 'password'],
    ['non-boolean setting', { settings: { showAnswers: 'yes' } }, 'settings.showAnswers'],
    ['bad strikes', { antiCheatSettings: { toleranceStrikes: 11 } }, 'antiCheatSettings.toleranceStrikes'],
    ['no questions', { questions: [] }, 'questions'],
    ['101 questions', { questions: Array(101).fill(h.sampleQuestions()[2]) }, 'questions'],
  ];
  for (const [name, over, field] of cases) {
    const res = await create(h.quizPayload(over));
    assert.equal(res.status, 400, name);
    assert.equal(res.body.code, 'VALIDATION_ERROR', name);
    assert.ok(detailFor(res, field), `${name}: expected a detail for ${field}, got ${JSON.stringify(res.body.details)}`);
  }
});

test('create: question rules (types, options, marks, integer, rubric, code)', async () => {
  const q = (over) => ({ ...h.sampleQuestions()[0], ...over });
  const two = [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }];
  const cases = [
    ['unknown type', q({ type: 'essay' }), 'questions[0].type'],
    ['empty text', q({ text: '' }), 'questions[0].text'],
    ['text too long', q({ text: 'x'.repeat(4001) }), 'questions[0].text'],
    ['negative marks', q({ marks: -1 }), 'questions[0].marks'],
    ['zero marks', q({ marks: 0 }), 'questions[0].marks'],
    ['marks 101', q({ marks: 101 }), 'questions[0].marks'],
    ['single with no correct', q({ options: [{ text: 'A' }, { text: 'B' }] }), 'questions[0].options'],
    ['single with two correct', q({ options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: true }] }), 'questions[0].options'],
    ['single with one option', q({ options: [{ text: 'A', isCorrect: true }] }), 'questions[0].options'],
    ['nine options', q({ options: Array.from({ length: 9 }, (_, i) => ({ text: `o${i}`, isCorrect: i === 0 })) }), 'questions[0].options'],
    ['duplicate option text', q({ options: [{ text: 'A', isCorrect: true }, { text: 'A' }] }), 'questions[0].options[1].text'],
    ['option text too long', q({ options: [{ text: 'x'.repeat(501), isCorrect: true }, { text: 'B' }] }), 'questions[0].options[0].text'],
    ['multiple with no correct', q({ type: 'multiple', options: [{ text: 'A' }, { text: 'B' }] }), 'questions[0].options'],
    ['integer not numeric', { type: 'integer', text: 'q', marks: 1, correctAnswer: 'abc' }, 'questions[0].correctAnswer'],
    ['integer missing', { type: 'integer', text: 'q', marks: 1 }, 'questions[0].correctAnswer'],
    ['text without rubric', { type: 'text', text: 'q', marks: 1 }, 'questions[0].aiGradingRubric'],
    ['rubric too long', { type: 'text', text: 'q', marks: 1, aiGradingRubric: 'x'.repeat(4001) }, 'questions[0].aiGradingRubric'],
    ['bad code language', { type: 'code', text: 'q', marks: 1, correctAnswer: 'r', codeLanguage: 'cobol' }, 'questions[0].codeLanguage'],
    ['starter code too long', { type: 'code', text: 'q', marks: 1, correctAnswer: 'r', starterCode: 'x'.repeat(8001) }, 'questions[0].starterCode'],
  ];
  for (const [name, question, field] of cases) {
    const res = await create(h.quizPayload({ questions: [question] }));
    assert.equal(res.status, 400, name);
    assert.ok(detailFor(res, field), `${name}: expected ${field}, got ${JSON.stringify(res.body.details)}`);
  }
  const ok = await create(h.quizPayload({ questions: [{ type: 'multiple', text: 'q', marks: 1, options: two.map((o) => ({ ...o, isCorrect: true })) }] }));
  assert.equal(ok.status, 201);
});

test('ownership: teacher B cannot read, update, duplicate, analyse or delete teacher A quiz; 404 hides existence', async () => {
  const quizId = await h.createQuiz(api, A);
  const missing = new h.mongoose.Types.ObjectId().toString();
  const attempts = [
    (id) => api.get(`/api/quizzes/${id}`).set(B.auth),
    (id) => api.put(`/api/quizzes/${id}`).set(B.auth).send(h.quizPayload({ title: 'hijack' })),
    (id) => api.post(`/api/quizzes/${id}/duplicate`).set(B.auth),
    (id) => api.get(`/api/quizzes/${id}/analytics`).set(B.auth),
    (id) => api.delete(`/api/quizzes/${id}`).set(B.auth),
    (id) => api.post('/api/quizzes/toggle-public').set(B.auth).send({ quizId: id }),
  ];
  for (const call of attempts) {
    const foreign = await call(quizId);
    const none = await call(missing);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.status, none.status);
    assert.equal(foreign.body.code, none.body.code);
    assert.equal(foreign.body.message, none.body.message);
  }
  const still = await h.Quiz.findById(quizId);
  assert.equal(still.title, 'Sample quiz');
  assert.equal((await api.get(`/api/quizzes/${quizId}`).set(A.auth)).status, 200);
  assert.equal((await api.get('/api/quizzes/not-an-id').set(A.auth)).status, 400);
});

test('update: owner can edit freely before submissions; question changes are blocked after one', async () => {
  const quizId = await h.createQuiz(api, A);
  const edited = h.quizPayload({ title: 'Renamed quiz', timeLimit: 45, passingScore: 70, password: 'newpw' });
  edited.questions = edited.questions.slice(0, 3);
  const res = await api.put(`/api/quizzes/${quizId}`).set(A.auth).send(edited);
  assert.equal(res.status, 200);
  let q = await h.Quiz.findById(quizId);
  assert.equal(q.title, 'Renamed quiz');
  assert.equal(q.questions.length, 3);
  assert.equal(q.timeLimit, 45);
  assert.match(q.password, /^\$2[aby]\$/);
  assert.equal(q.isPublic, true, 'publish state is untouched');

  // a first submission appears
  await h.beginAttempt(api, quizId, 'first@example.com', { password: 'newpw' });

  const blockedQ = h.quizPayload({ ...edited, questions: edited.questions.slice(0, 2) });
  const r1 = await api.put(`/api/quizzes/${quizId}`).set(A.auth).send(blockedQ);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'QUIZ_HAS_SUBMISSIONS');
  assert.equal((await api.put(`/api/quizzes/${quizId}`).set(A.auth).send({ ...edited, timeLimit: 10 })).body.code, 'QUIZ_HAS_SUBMISSIONS');
  assert.equal((await api.put(`/api/quizzes/${quizId}`).set(A.auth).send({ ...edited, passingScore: 10 })).body.code, 'QUIZ_HAS_SUBMISSIONS');

  // metadata stays editable, identical questions are accepted, password is kept when omitted
  const meta = { ...edited, title: 'Third title', description: 'new', password: undefined, settings: { showAnswers: false } };
  const r2 = await api.put(`/api/quizzes/${quizId}`).set(A.auth).send(meta);
  assert.equal(r2.status, 200);
  q = await h.Quiz.findById(quizId);
  assert.equal(q.title, 'Third title');
  assert.equal(q.settings.showAnswers, false);
  assert.match(q.password, /^\$2[aby]\$/, 'password kept');
  assert.equal(q.questions.length, 3);
  // validation also applies to PUT
  assert.equal((await api.put(`/api/quizzes/${quizId}`).set(A.auth).send({ ...edited, title: 'x' })).status, 400);
});

test('duplicate: copies as an unpublished draft with " (copy)" and fresh ids', async () => {
  const quizId = await h.createQuiz(api, A);
  const res = await api.post(`/api/quizzes/${quizId}/duplicate`).set(A.auth);
  assert.equal(res.status, 201);
  const copy = await h.Quiz.findById(res.body.quizId);
  assert.equal(copy.title, 'Sample quiz (copy)');
  assert.equal(copy.isPublic, false);
  assert.equal(copy.questions.length, 5);
  const orig = await h.Quiz.findById(quizId);
  assert.notEqual(String(copy.questions[0]._id), String(orig.questions[0]._id));
  assert.deepEqual(copy.questions.map((q) => q.originalIndex), [0, 1, 2, 3, 4]);
});

test('toggle-public publishes and unpublishes, and refuses a legacy quiz that fails validation', async () => {
  const quizId = await h.createQuiz(api, A, {}, { publish: false });
  const on = await api.post('/api/quizzes/toggle-public').set(A.auth).send({ quizId });
  assert.equal(on.body.isPublic, true);
  const off = await api.post('/api/quizzes/toggle-public').set(A.auth).send({ quizId });
  assert.equal(off.body.isPublic, false);

  // legacy document with an invalid question (single with no correct option), inserted bypassing the API
  const legacy = await h.Quiz.collection.insertOne({
    userId: new h.mongoose.Types.ObjectId(A.userId),
    title: 'Legacy quiz',
    isPublic: false,
    questions: [{ _id: new h.mongoose.Types.ObjectId(), type: 'single', text: 'q', marks: 1, options: [{ text: 'a', isCorrect: false }, { text: 'b', isCorrect: false }] }],
  });
  const res = await api.post('/api/quizzes/toggle-public').set(A.auth).send({ quizId: String(legacy.insertedId) });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal((await h.Quiz.findById(legacy.insertedId)).isPublic, false);
});

test('delete cascades to submissions and reports the count', async () => {
  const quizId = await h.createQuiz(api, A);
  await h.beginAttempt(api, quizId, 's1@example.com');
  await h.beginAttempt(api, quizId, 's2@example.com');
  assert.equal(await h.Submission.countDocuments({ quizId }), 2);
  const res = await api.delete(`/api/quizzes/${quizId}`).set(A.auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.deletedSubmissions, 2);
  assert.equal(await h.Submission.countDocuments({ quizId }), 0);
  assert.equal(await h.Quiz.countDocuments({ _id: quizId }), 0);
});

test('my-quizzes: pagination, search, status filter, sort and aggregated stats', async () => {
  const ids = [];
  for (let i = 1; i <= 5; i++) ids.push(await h.createQuiz(api, A, { title: `Quiz ${String.fromCharCode(64 + i)}` }, { publish: i % 2 === 1 }));
  await h.createQuiz(api, B, { title: 'Other teacher quiz' });

  // seed submissions on quiz 1 (passing score 50): 80 submitted, 20 submitted, 1 in-progress flagged
  const quiz1 = await h.Quiz.findById(ids[0]);
  const mk = (email, status, pct, flagged = false) => ({
    quizId: quiz1._id, userDetails: { name: email, email }, status, score: { totalMarks: 10, obtainedMarks: pct / 10, percentage: pct },
    antiCheat: { isFlagged: flagged },
  });
  await h.Submission.create([mk('p1@x.co', 'submitted', 80), mk('p2@x.co', 'graded', 20), mk('p3@x.co', 'in-progress', 0, true)]);

  const page1 = await api.get('/api/quizzes/my-quizzes?page=1&limit=2').set(A.auth);
  assert.equal(page1.status, 200);
  assert.equal(page1.body.quizzes.length, 2);
  assert.deepEqual(page1.body.pagination, { page: 1, limit: 2, total: 5, pages: 3 });
  const page3 = await api.get('/api/quizzes/my-quizzes?page=3&limit=2').set(A.auth);
  assert.equal(page3.body.quizzes.length, 1);

  const all = await api.get('/api/quizzes/my-quizzes?limit=100&sort=title').set(A.auth);
  assert.deepEqual(all.body.quizzes.map((q) => q.title), ['Quiz A', 'Quiz B', 'Quiz C', 'Quiz D', 'Quiz E']);
  const first = all.body.quizzes[0];
  assert.equal(first.questionCount, 5);
  assert.equal(first.totalMarks, 20);
  assert.equal(first.hasPassword, false);
  assert.equal(first.questions, undefined);
  assert.equal(first.password, undefined);
  assert.deepEqual(first.stats, { attempts: 3, submitted: 2, inProgress: 1, flagged: 1, avgPercentage: 50, passRate: 50 });
  assert.deepEqual(all.body.quizzes[1].stats, { attempts: 0, submitted: 0, inProgress: 0, flagged: 0, avgPercentage: 0, passRate: 0 });

  const published = await api.get('/api/quizzes/my-quizzes?status=published').set(A.auth);
  assert.equal(published.body.pagination.total, 3);
  const drafts = await api.get('/api/quizzes/my-quizzes?status=draft').set(A.auth);
  assert.equal(drafts.body.pagination.total, 2);
  const search = await api.get('/api/quizzes/my-quizzes?search=quiz%20c').set(A.auth);
  assert.deepEqual(search.body.quizzes.map((q) => q.title), ['Quiz C']);
  const oldest = await api.get('/api/quizzes/my-quizzes?sort=oldest&limit=1').set(A.auth);
  assert.equal(oldest.body.quizzes[0].title, 'Quiz A');
  assert.equal((await api.get('/api/quizzes/my-quizzes?status=bogus').set(A.auth)).status, 400);
  assert.equal((await api.get('/api/quizzes/my-quizzes?search[$ne]=x').set(A.auth)).status, 400);
});

test('dashboard/summary numbers match seeded data', async () => {
  const q1 = await h.createQuiz(api, A, { title: 'Dash one', passingScore: 50 });
  const q2 = await h.createQuiz(api, A, { title: 'Dash two', passingScore: 90 }, { publish: false });
  const other = await h.createQuiz(api, B, { title: 'Not mine' });
  const now = new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000);
  const mk = (quizId, email, status, pct, extra = {}) => ({
    quizId, userDetails: { name: email.split('@')[0], email }, status, score: { totalMarks: 10, obtainedMarks: pct / 10, percentage: pct }, ...extra,
  });
  await h.Submission.create([
    mk(q1, 'a1@x.co', 'submitted', 60, { startedAt: daysAgo(1), submittedAt: daysAgo(1) }),
    mk(q1, 'a2@x.co', 'graded', 40, { startedAt: daysAgo(2), submittedAt: daysAgo(2) }),
    mk(q2, 'a3@x.co', 'submitted', 80, { startedAt: daysAgo(1), submittedAt: daysAgo(1), antiCheat: { isFlagged: true } }),
    mk(q2, 'a4@x.co', 'in-progress', 0, { startedAt: daysAgo(0) }),
    mk(q2, 'a5@x.co', 'submitted', 95, { startedAt: daysAgo(30), submittedAt: daysAgo(30) }),
    mk(other, 'o1@x.co', 'submitted', 100),
  ]);
  const res = await api.get('/api/dashboard/summary').set(A.auth);
  assert.equal(res.status, 200);
  // submitted+graded = a1(60,pass50) a2(40,fail) a3(80,fail90) a5(95,pass90) -> avg 68.75, pass 2/4
  assert.deepEqual(res.body.totals, { quizzes: 2, published: 1, drafts: 1, attempts: 5, submitted: 4, inProgress: 1, flagged: 1, avgPercentage: 68.75, passRate: 50 });
  assert.equal(res.body.activity.length, 14);
  const sum = (k) => res.body.activity.reduce((s, d) => s + d[k], 0);
  assert.equal(sum('attempts'), 4, '30-day-old attempt is outside the 14-day window');
  assert.equal(sum('submitted'), 3);
  assert.equal(res.body.activity[13].date, new Date().toISOString().slice(0, 10));
  assert.equal(res.body.recentSubmissions.length, 5);
  assert.ok(res.body.recentSubmissions.every((s) => s.email !== 'o1@x.co'));
  assert.equal(res.body.recentSubmissions[0].email, 'a4@x.co');
  assert.equal(res.body.recentQuizzes.length, 2);
  assert.equal(res.body.recentQuizzes.find((q) => q.title === 'Dash two').attempts, 3);

  const empty = await api.get('/api/dashboard/summary').set((await h.registerTeacher(api)).auth);
  assert.equal(empty.body.totals.quizzes, 0);
  assert.equal(empty.body.activity.length, 14);
});

test('analytics: real numbers from seeded submissions, zeros when empty', async () => {
  const quizId = await h.createQuiz(api, A, { passingScore: 50 });
  const empty = await api.get(`/api/quizzes/${quizId}/analytics`).set(A.auth);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.summary, { attempts: 0, submitted: 0, avgPercentage: 0, medianPercentage: 0, highest: 0, lowest: 0, passRate: 0, avgDurationSeconds: 0 });
  assert.equal(empty.body.scoreDistribution.length, 10);
  assert.equal(empty.body.questions.length, 5);

  const quiz = await h.Quiz.findById(quizId);
  const t0 = new Date('2026-01-01T10:00:00Z');
  const mk = (email, pct, secs, firstCorrect) => ({
    quizId, userDetails: { name: email, email }, status: 'submitted', startedAt: t0, submittedAt: new Date(t0.getTime() + secs * 1000),
    score: { totalMarks: 20, obtainedMarks: pct / 5, percentage: pct },
    questions: quiz.questions.map((q, i) => ({
      questionId: i, questionRef: q._id, questionType: q.type, marks: q.marks,
      userAnswer: i === 0 ? 'Paris' : null, isCorrect: i === 0 && firstCorrect, marksObtained: i === 0 && firstCorrect ? q.marks : 0,
    })),
  });
  await h.Submission.create([mk('s1@x.co', 100, 60, true), mk('s2@x.co', 40, 120, false), mk('s3@x.co', 0, 180, false), mk('s4@x.co', 95, 120, true)]);
  const res = await api.get(`/api/quizzes/${quizId}/analytics`).set(A.auth);
  assert.deepEqual(res.body.summary, { attempts: 4, submitted: 4, avgPercentage: 58.75, medianPercentage: 67.5, highest: 100, lowest: 0, passRate: 50, avgDurationSeconds: 120 });
  const d = Object.fromEntries(res.body.scoreDistribution.map((b) => [b.range, b.count]));
  assert.equal(d['0-9'], 1);
  assert.equal(d['40-49'], 1);
  assert.equal(d['90-100'], 2);
  const q0 = res.body.questions[0];
  assert.equal(q0.answered, 4);
  assert.equal(q0.correctRate, 50);
  assert.equal(q0.avgMarks, 1);
  assert.equal(res.body.questions[1].answered, 0);
});

test('public quiz: never contains answers, rubrics or the password; unpublished is 403', async () => {
  const quizId = await h.createQuiz(api, A, { password: 'secret' });
  const res = await api.get(`/api/quizzes/public/${quizId}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.serverTime);
  assert.equal(res.body.quiz.isPasswordProtected, true);
  const raw = JSON.stringify(res.body);
  for (const forbidden of ['isCorrect', 'correctAnswer', 'aiGradingRubric', 'Mentions mass', 'Returns a+b', 'secret', '"password"']) {
    assert.ok(!raw.includes(forbidden), `public payload must not contain ${forbidden}`);
  }
  assert.equal(res.body.quiz.questions[0].options[0].text.length > 0, true);
  assert.equal(res.body.quiz.questions[4].starterCode, 'function add(a,b){}');

  await api.post('/api/quizzes/toggle-public').set(A.auth).send({ quizId });
  const hidden = await api.get(`/api/quizzes/public/${quizId}`);
  assert.equal(hidden.status, 403);
  assert.equal(hidden.body.code, 'QUIZ_NOT_PUBLISHED');
  assert.equal((await api.get(`/api/quizzes/public/${new h.mongoose.Types.ObjectId()}`)).status, 404);
});
