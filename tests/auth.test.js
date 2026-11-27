const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let api;
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
});

test('app has a health route that does not touch the database', async () => {
  const res = await api.get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('register ignores role and always creates a teacher', async () => {
  const res = await api.post('/api/auth/register').send({ name: 'Mallory', email: 'Mallory@Example.com', password: 'password123', role: 'admin' });
  assert.equal(res.status, 201);
  const user = await h.User.findOne({ email: 'mallory@example.com' });
  assert.ok(user, 'email is stored lowercased');
  assert.equal(user.role, 'teacher');
});

test('register validates input and returns details', async () => {
  const res = await api.post('/api/auth/register').send({ name: 'A', email: 'not-an-email', password: 'short' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.ok(res.body.details.length >= 3);
  assert.equal(res.body.success, false);
});

test('duplicate email returns 409 CONFLICT', async () => {
  const body = { name: 'Dup', email: 'dup@example.com', password: 'password123' };
  assert.equal((await api.post('/api/auth/register').send(body)).status, 201);
  const res = await api.post('/api/auth/register').send(body);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CONFLICT');
});

test('operator-injection payloads are rejected', async () => {
  await h.registerTeacher(api, 'victim@example.com');
  const res = await api.post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  const res2 = await api.post('/api/auth/login').send({ email: 'victim@example.com', password: { $gt: '' } });
  assert.equal(res2.status, 400);
  // dotted / dollar keys anywhere in the body
  const res3 = await api.post('/api/quizzes/create').set((await h.registerTeacher(api)).auth).send({ title: 'x', 'a.b': 1 });
  assert.equal(res3.status, 400);
  assert.equal(res3.body.code, 'VALIDATION_ERROR');
  // a non-object body
  const res4 = await api.post('/api/auth/login').set('Content-Type', 'application/json').send('[1,2]');
  assert.equal(res4.status, 400);
});

test('login: success shape, and one generic error for unknown email and wrong password', async () => {
  const t = await h.registerTeacher(api, 'login@example.com');
  const ok = await api.post('/api/auth/login').send({ email: 'LOGIN@example.com', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token && ok.body.userId);
  assert.deepEqual(ok.body.user, { name: 'Test Teacher', email: 'login@example.com', role: 'teacher' });
  assert.equal(ok.body.isPasswordSet, true);

  const wrong = await api.post('/api/auth/login').send({ email: 'login@example.com', password: 'wrong-password' });
  const unknown = await api.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'password123' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.message, unknown.body.message);
  assert.equal(wrong.body.code, 'UNAUTHENTICATED');
  assert.ok(t.token);
});

test('google login links an existing account only when email_verified is true', async () => {
  await h.registerTeacher(api, 'linked@example.com');
  const bad = await api.post('/api/auth/google').send({ credential: 'g:linked@example.com:Linked:unverified' });
  assert.equal(bad.status, 401);
  assert.equal((await h.User.findOne({ email: 'linked@example.com' })).googleId, null);

  const good = await api.post('/api/auth/google').send({ credential: 'g:linked@example.com:Linked' });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
  assert.equal((await h.User.findOne({ email: 'linked@example.com' })).googleId, 'sub-linked@example.com');

  const fresh = await api.post('/api/auth/google').send({ credential: 'g:new@example.com:New Person' });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.isPasswordSet, false);
  const invalid = await api.post('/api/auth/google').send({ credential: 'garbage' });
  assert.equal(invalid.status, 401);
});

test('profile: role is returned; changing an existing password needs currentPassword', async () => {
  const t = await h.registerTeacher(api, 'profile@example.com');
  const get = await api.get('/api/auth/profile').set(t.auth);
  assert.equal(get.body.data.role, 'teacher');

  const noCurrent = await api.put('/api/auth/profile').set(t.auth).send({ newPassword: 'newpassword1' });
  assert.equal(noCurrent.status, 403);
  assert.equal(noCurrent.body.code, 'FORBIDDEN');
  const wrong = await api.put('/api/auth/profile').set(t.auth).send({ newPassword: 'newpassword1', currentPassword: 'nope-nope' });
  assert.equal(wrong.status, 403);
  const ok = await api.put('/api/auth/profile').set(t.auth).send({ newPassword: 'newpassword1', currentPassword: 'password123', bio: 'hello' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.profile.bio, 'hello');
  const relog = await api.post('/api/auth/login').send({ email: 'profile@example.com', password: 'newpassword1' });
  assert.equal(relog.status, 200);

  const tooLong = await api.put('/api/auth/profile').set(t.auth).send({ bio: 'x'.repeat(501) });
  assert.equal(tooLong.status, 400);
});

test('google-only account can set a first password without currentPassword', async () => {
  const g = await api.post('/api/auth/google').send({ credential: 'g:gonly@example.com:G Only' });
  const res = await api.put('/api/auth/profile').set({ Authorization: `Bearer ${g.body.token}` }).send({ newPassword: 'firstpass123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.isPasswordSet, true);
});

test('protected routes: missing, malformed, student and unknown-user tokens are rejected', async () => {
  assert.equal((await api.get('/api/auth/profile')).status, 401);
  const bad = await api.get('/api/auth/profile').set('Authorization', 'Bearer not.a.jwt');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'UNAUTHENTICATED');
  const { signStudentToken, signTeacherToken } = require('../services/tokenService');
  const st = signStudentToken({ email: 's@example.com', name: 'S' });
  assert.equal((await api.get('/api/auth/profile').set('Authorization', `Bearer ${st}`)).status, 401);
  const ghost = signTeacherToken(new h.mongoose.Types.ObjectId(), 'teacher');
  assert.equal((await api.get('/api/auth/profile').set('Authorization', `Bearer ${ghost}`)).status, 401);
});

test('errors never leak stack traces or internal messages', async () => {
  const res = await api.get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
  assert.equal(res.body.stack, undefined);
  const parse = await api.post('/api/auth/login').set('Content-Type', 'application/json').send('{"bad json');
  assert.equal(parse.status, 400);
  assert.equal(parse.body.stack, undefined);
});

test('body size limits: 100 kb default returns 413 PAYLOAD_TOO_LARGE', async () => {
  const res = await api.post('/api/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(150 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
});

test('rate limit: the 11th login attempt in the window gets 429 RATE_LIMITED', async () => {
  const limited = h.request(require('../app').createApp({ rateLimit: true }));
  let last;
  for (let i = 0; i < 11; i++) last = await limited.post('/api/auth/login').send({ email: 'x@example.com', password: 'password123' });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'RATE_LIMITED');
  assert.equal(last.body.success, false);
});

test('CORS: allow-list from CORS_ORIGIN', async () => {
  process.env.CORS_ORIGIN = 'https://app.example.com';
  try {
    const app = h.getApp();
    const ok = await app.get('/health').set('Origin', 'https://app.example.com');
    assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com');
    const no = await app.get('/health').set('Origin', 'https://evil.example.com');
    assert.equal(no.headers['access-control-allow-origin'], undefined);
  } finally {
    delete process.env.CORS_ORIGIN;
  }
});
