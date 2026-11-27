// Shared test helpers. Test code only: Google and Gemini are replaced by doubles here;
// production code always calls the real services.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-unit-tests-only';
process.env.NODE_ENV = 'test';
process.env.ATTEMPT_GRACE_SECONDS = '15';

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createApp } = require('../app');
const Quiz = require('../models/Quiz');
const Submission = require('../models/Submission');
const User = require('../models/User');
const { setGoogleVerifier } = require('../services/googleVerifier');
const { setAiClient } = require('../services/aiClient');

let mongod;

const startDb = async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'quizify_test' });
  await Promise.all([User.init(), Quiz.init(), Submission.init()]);
};

const stopDb = async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
};

const clearDb = async () => {
  await Promise.all([User.deleteMany({}), Quiz.deleteMany({}), Submission.deleteMany({})]);
};

// Google double. Credential format: "g:<email>[:<name>[:unverified]]"
const installGoogleDouble = () => {
  setGoogleVerifier(async (credential) => {
    const [kind, email, name, flag] = String(credential).split(':');
    if (kind !== 'g' || !email) throw new Error('invalid credential');
    return { email, name: name || 'Student', sub: `sub-${email}`, email_verified: flag !== 'unverified', picture: '' };
  });
};

// Gemini double. `handler(prompt)` returns the JSON the "model" answers with (or throws).
const installAiDouble = (handler) => setAiClient(async (prompt) => handler(prompt));
const resetDoubles = () => {
  setGoogleVerifier();
  setAiClient();
};

const getApp = (opts = { rateLimit: false }) => request(createApp(opts));

let counter = 0;
const registerTeacher = async (agent, email = `teacher${++counter}@example.com`) => {
  const reg = await agent.post('/api/auth/register').send({ name: 'Test Teacher', email, password: 'password123' });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const login = await agent.post('/api/auth/login').send({ email, password: 'password123' });
  return { token: login.body.token, userId: login.body.userId, email, auth: { Authorization: `Bearer ${login.body.token}` } };
};

const sampleQuestions = () => [
  { type: 'single', text: 'Capital of France?', marks: 2, options: [{ text: 'Paris', isCorrect: true }, { text: 'Rome', isCorrect: false }] },
  {
    type: 'multiple',
    text: 'Pick primes',
    marks: 3,
    options: [{ text: '2', isCorrect: true }, { text: '3', isCorrect: true }, { text: '4', isCorrect: false }],
  },
  { type: 'integer', text: '2 + 3 = ?', marks: 2, correctAnswer: '5' },
  { type: 'text', text: 'Explain gravity', marks: 5, aiGradingRubric: 'Mentions mass attracting mass' },
  { type: 'code', text: 'Write add(a,b)', marks: 8, codeLanguage: 'javascript', starterCode: 'function add(a,b){}', correctAnswer: 'Returns a+b' },
];

const quizPayload = (over = {}) => ({
  title: 'Sample quiz',
  description: 'desc',
  timeLimit: 30,
  passingScore: 50,
  settings: { shuffleQuestions: false, shuffleOptions: false, showAnswers: true },
  questions: sampleQuestions(),
  ...over,
});

const createQuiz = async (agent, teacher, over = {}, { publish = true } = {}) => {
  const res = await agent.post('/api/quizzes/create').set(teacher.auth).send(quizPayload(over));
  if (res.status !== 201) throw new Error(`create quiz failed: ${res.status} ${JSON.stringify(res.body)}`);
  const quizId = res.body.quizId;
  if (publish) {
    const t = await agent.post('/api/quizzes/toggle-public').set(teacher.auth).send({ quizId });
    if (t.status !== 200) throw new Error(`publish failed: ${JSON.stringify(t.body)}`);
  }
  return quizId;
};

// Student helpers -----------------------------------------------------------
const studentLogin = async (agent, quizId, email = 'student@example.com', name = 'Stu Dent') => {
  const res = await agent.post('/api/submissions/verify-google').send({ quizId, credential: `g:${email}:${name}` });
  return res;
};

const startAttempt = async (agent, quizId, student, extra = {}) =>
  agent.post('/api/submissions/start-attempt').set('Authorization', `Student ${student.studentToken}`).send({ quizId, ...extra });

// Quick path: verify + start. Returns { studentToken, submissionId, attemptToken, headers }.
const beginAttempt = async (agent, quizId, email = 'student@example.com', extra = {}) => {
  const v = await studentLogin(agent, quizId, email);
  if (v.status !== 200) throw new Error(`verify failed: ${v.status} ${JSON.stringify(v.body)}`);
  const s = await startAttempt(agent, quizId, v.body, extra);
  if (s.status !== 200) throw new Error(`start failed: ${s.status} ${JSON.stringify(s.body)}`);
  return {
    studentToken: v.body.studentToken,
    submissionId: s.body.submissionId,
    attemptToken: s.body.attemptToken,
    start: s.body,
    headers: { 'X-Attempt-Token': s.body.attemptToken },
  };
};

const publicQuiz = async (agent, quizId) => (await agent.get(`/api/quizzes/public/${quizId}`)).body.quiz;

// Builds an `answers` array from the public quiz: map index -> userAnswer.
const answersFor = (quiz, byIndex) =>
  Object.entries(byIndex).map(([i, userAnswer]) => ({ questionId: quiz.questions[Number(i)]._id, userAnswer }));

const perfectAiGrader = (grade = (it) => it.maxMarks) => (prompt) => {
  const m = /Items \(JSON\):\n(.*)\n/.exec(prompt);
  const items = JSON.parse(m[1]);
  return items.map((it) => ({ questionId: it.questionId, awardedMarks: grade(it), feedback: 'ok' }));
};

module.exports = {
  request,
  mongoose,
  Quiz,
  Submission,
  User,
  startDb,
  stopDb,
  clearDb,
  installGoogleDouble,
  installAiDouble,
  resetDoubles,
  getApp,
  registerTeacher,
  quizPayload,
  sampleQuestions,
  createQuiz,
  studentLogin,
  startAttempt,
  beginAttempt,
  publicQuiz,
  answersFor,
  perfectAiGrader,
};
