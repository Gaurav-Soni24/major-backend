const mongoose = require('mongoose');
const Quiz = require('../models/Quiz');
const Submission = require('../models/Submission');
const { AppError } = require('../utils/AppError');
const { graceMs } = require('../config/env');
const { newAttemptToken, hashAttemptToken } = require('./tokenService');
const { checkQuizPassword, hashQuizPassword } = require('./quizPassword');
const { gradeSubjectiveAnswers } = require('./aiGrader');
const { gradeObjectiveAndPlan, mergeAiResults, computeTotals, isBlank } = require('./gradingService');
const { validateAnswers, validateAntiCheat } = require('../validators/answers');
const { Issues, isPlainObject, isString } = require('../validators/common');
const { parseNumeric } = require('../validators/quiz');

const NO_IMAGES = '-antiCheat.flaggedImages';
const DONE = ['submitted', 'graded'];

// ---------------------------------------------------------------- time helpers

const deadlineOf = (sub, quiz) => {
  if (sub.deadlineAt) return new Date(sub.deadlineAt);
  if (quiz && quiz.timeLimit) return new Date(new Date(sub.startedAt).getTime() + quiz.timeLimit * 60000);
  return null;
};

const isPastGrace = (sub, quiz, now = new Date()) => {
  const d = deadlineOf(sub, quiz);
  return !!d && now.getTime() > d.getTime() + graceMs();
};

const remainingSeconds = (sub, quiz, now = new Date()) => {
  const d = deadlineOf(sub, quiz);
  return d ? Math.max(0, Math.ceil((d.getTime() - now.getTime()) / 1000)) : null;
};

// ---------------------------------------------------------------- helpers

const skeletonFor = (quiz) =>
  quiz.questions.map((q, i) => ({
    questionId: q.originalIndex !== undefined && q.originalIndex !== null ? q.originalIndex : i,
    questionRef: q._id,
    questionText: q.text,
    questionType: q.type,
    userAnswer: null,
    marks: q.marks,
  }));

const savedAnswersOf = (sub) =>
  (sub.questions || [])
    .filter((q) => q.questionRef && !isBlank(q.userAnswer))
    .map((q) => ({ questionId: String(q.questionRef), userAnswer: q.userAnswer }));

// Validates student-supplied custom registration data against the quiz's custom fields.
const validateCustomData = (quiz, input) => {
  const issues = new Issues();
  const src = isPlainObject(input) ? input : {};
  const out = {};
  for (const f of quiz.customFields || []) {
    const v = src[f.name];
    if (v === undefined || v === null || (isString(v) && v.trim() === '')) {
      issues.add(`customData.${f.name}`, `${f.name} is required`);
      continue;
    }
    if (f.type === 'number') {
      if (Number.isNaN(parseNumeric(v)) || String(v).length > 40) issues.add(`customData.${f.name}`, `${f.name} must be a number`);
      else out[f.name] = String(v).trim();
    } else if (!isString(v) || v.trim().length > 200) {
      issues.add(`customData.${f.name}`, `${f.name} must be text of at most 200 characters`);
    } else out[f.name] = v.trim();
  }
  issues.throwIfAny('Missing or invalid registration details');
  return out;
};

const isDuplicateKey = (err) => err && (err.code === 11000 || err.code === 11001);

// ---------------------------------------------------------------- start / resume

const startAttempt = async ({ quiz, student, customData, password }) => {
  if (!quiz.isPublic) throw new AppError(403, 'QUIZ_NOT_PUBLISHED', 'This quiz is not available');

  const pw = await checkQuizPassword(quiz.password, password);
  if (!pw.ok) throw new AppError(401, 'WRONG_PASSWORD', 'Incorrect quiz password.');
  if (pw.legacy) {
    // Plaintext legacy password accepted once: re-hash it now (only if nobody changed it meanwhile).
    const hashed = await hashQuizPassword(password);
    await Quiz.updateOne({ _id: quiz._id, password: quiz.password }, { $set: { password: hashed } });
  }

  const data = validateCustomData(quiz, customData);
  const email = student.email;

  const resume = async (existing) => {
    if (DONE.includes(existing.status)) throw new AppError(403, 'ALREADY_SUBMITTED', 'You have already submitted this assessment.');
    if (existing.status !== 'in-progress') throw new AppError(403, 'ALREADY_SUBMITTED', 'This attempt is closed.');
    if (isPastGrace(existing, quiz)) {
      await submitAttempt(existing._id, { auto: true });
      throw new AppError(403, 'ALREADY_SUBMITTED', 'The time for this attempt has ended and it was submitted.');
    }
    const token = newAttemptToken();
    const set = { attemptTokenHash: hashAttemptToken(token) };
    if (!existing.questions || existing.questions.length === 0) set.questions = skeletonFor(quiz);
    if (!existing.deadlineAt && quiz.timeLimit) set.deadlineAt = deadlineOf(existing, quiz);
    const updated = await Submission.findOneAndUpdate(
      { _id: existing._id, status: 'in-progress' },
      { $set: set, $inc: { 'antiCheat.reloads': 1 } },
      { returnDocument: 'after' }
    ).select(NO_IMAGES);
    if (!updated) throw new AppError(409, 'ALREADY_SUBMITTED', 'This attempt was just submitted.');
    return { submission: updated, token, resumed: true };
  };

  const existing = await Submission.findOne({ quizId: quiz._id, 'userDetails.email': email }).select(NO_IMAGES);
  if (existing) return resume(existing);

  const token = newAttemptToken();
  const startedAt = new Date();
  try {
    const created = await Submission.create({
      quizId: quiz._id,
      quizDescription: quiz.title,
      userDetails: { name: student.name || email.split('@')[0], email, googleId: student.googleId || null, customData: data },
      status: 'in-progress',
      startedAt,
      deadlineAt: quiz.timeLimit ? new Date(startedAt.getTime() + quiz.timeLimit * 60000) : null,
      attemptTokenHash: hashAttemptToken(token),
      questions: skeletonFor(quiz),
    });
    return { submission: created, token, resumed: false };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Lost a race with a concurrent start: resume the winner's attempt.
    const winner = await Submission.findOne({ quizId: quiz._id, 'userDetails.email': email }).select(NO_IMAGES);
    if (!winner) throw err;
    return resume(winner);
  }
};

// ---------------------------------------------------------------- autosave

const saveAnswers = async ({ submission, quiz, answers, antiCheat }) => {
  if (submission.status !== 'in-progress') throw new AppError(409, 'ALREADY_SUBMITTED', 'This attempt is already submitted.');
  const now = new Date();
  if (isPastGrace(submission, quiz, now)) throw new AppError(410, 'ATTEMPT_EXPIRED', 'The time for this attempt has ended.');

  const incoming = validateAnswers(answers, quiz);
  const ac = validateAntiCheat(antiCheat);

  const set = { lastSavedAt: now };
  const arrayFilters = [];
  let n = 0;
  for (const [qid, value] of incoming) {
    const id = `q${n++}`;
    set[`questions.$[${id}].userAnswer`] = value;
    arrayFilters.push({ [`${id}.questionRef`]: new mongoose.Types.ObjectId(qid) });
  }
  const update = { $set: set };
  const max = {};
  for (const k of ['tabSwitches', 'webcamStrikes', 'copyPasteAttempts']) if (ac[k] !== undefined) max[`antiCheat.${k}`] = ac[k];
  if (Object.keys(max).length) update.$max = max;

  const res = await Submission.updateOne({ _id: submission._id, status: 'in-progress' }, update, arrayFilters.length ? { arrayFilters } : {});
  if (res.matchedCount === 0) throw new AppError(409, 'ALREADY_SUBMITTED', 'This attempt is already submitted.');
  return { savedAt: now, remainingSeconds: remainingSeconds(submission, quiz, now), serverTime: now };
};

// ---------------------------------------------------------------- final submit

// One in-process grading per attempt; the DB claim below protects across processes.
const inflight = new Map();

const submitAttempt = (submissionId, opts = {}) => {
  const key = String(submissionId);
  if (inflight.has(key)) return inflight.get(key);
  const p = doSubmit(key, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};

const doSubmit = async (submissionId, { answers, antiCheat, auto = false } = {}) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sub = await Submission.findById(submissionId).select(NO_IMAGES);
    if (!sub) throw new AppError(404, 'NOT_FOUND', 'Submission not found');
    const quiz = await Quiz.findById(sub.quizId);
    if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Quiz not found');
    if (sub.status !== 'in-progress') return { submission: sub, quiz, replay: true };

    const now = new Date();
    const late = !auto && isPastGrace(sub, quiz, now);
    const ac = validateAntiCheat(antiCheat);
    const incoming = answers !== undefined && answers !== null ? validateAnswers(answers, quiz) : new Map();

    // Saved answers first; body answers override them only while the attempt is still open.
    const merged = new Map();
    for (const a of savedAnswersOf(sub)) merged.set(a.questionId, a.userAnswer);
    if (!late && !auto) {
      for (const [qid, v] of incoming) {
        if (v === null) merged.delete(qid);
        else merged.set(qid, v);
      }
    }

    const { records, pending } = gradeObjectiveAndPlan(quiz, merged);
    const aiOutcome = pending.length ? await gradeSubjectiveAnswers(pending) : { results: new Map(), ok: true };
    const { needsReview } = mergeAiResults(records, pending, aiOutcome);
    const totals = computeTotals(records, quiz.passingScore);

    const set = {
      status: 'submitted',
      submittedAt: now,
      score: { totalMarks: totals.totalMarks, obtainedMarks: totals.obtainedMarks, percentage: totals.percentage },
      questions: records,
      needsReview,
      late,
      gradedAt: needsReview ? null : now,
      'antiCheat.wasAutoSubmitted': auto || late || ac.wasAutoSubmitted === true,
      'antiCheat.identitySwapDetected': ac.identitySwapDetected === true || !!(sub.antiCheat && sub.antiCheat.identitySwapDetected),
    };
    if (ac.isFlagged || (sub.antiCheat && (sub.antiCheat.isFlagged || sub.antiCheat.flagCount > 0))) set['antiCheat.isFlagged'] = true;
    const max = {};
    for (const k of ['tabSwitches', 'webcamStrikes', 'copyPasteAttempts']) if (ac[k] !== undefined) max[`antiCheat.${k}`] = ac[k];
    const update = { $set: set };
    if (Object.keys(max).length) update.$max = max;

    // Atomic claim: only one caller can move in-progress -> submitted. The lastSavedAt guard makes
    // us re-grade if an autosave landed while we were grading.
    const claimed = await Submission.findOneAndUpdate(
      { _id: sub._id, status: 'in-progress', lastSavedAt: sub.lastSavedAt || null },
      update,
      { returnDocument: 'after' }
    ).select(NO_IMAGES);
    if (claimed) return { submission: claimed, quiz, replay: false };
  }
  const stored = await Submission.findById(submissionId).select(NO_IMAGES);
  const quiz = await Quiz.findById(stored.quizId);
  if (stored.status === 'in-progress') throw new AppError(409, 'CONFLICT', 'Could not finalize the attempt, please retry.');
  return { submission: stored, quiz, replay: true };
};

// Finalizes attempts whose deadline + grace has passed (graded from saved answers).
const finalizeExpired = async ({ quizId, limit = 50 } = {}) => {
  const filter = { status: 'in-progress', deadlineAt: { $ne: null, $lt: new Date(Date.now() - graceMs()) } };
  if (quizId) filter.quizId = quizId;
  const rows = await Submission.find(filter).select('_id').limit(limit).lean();
  let done = 0;
  for (const r of rows) {
    try {
      await submitAttempt(r._id, { auto: true });
      done++;
    } catch (err) {
      console.error('[attempts] failed to finalize expired attempt:', String(err && err.message).slice(0, 200));
    }
  }
  return done;
};

// ---------------------------------------------------------------- payloads

const scoreOf = (sub) => ({
  totalMarks: sub.score ? sub.score.totalMarks : 0,
  obtainedMarks: sub.score ? sub.score.obtainedMarks : 0,
  percentage: sub.score ? sub.score.percentage : 0,
});

const buildResultPayload = (sub, quiz) => {
  const score = scoreOf(sub);
  const showAnswers = !!(quiz.settings && quiz.settings.showAnswers);
  return {
    success: true,
    message: 'Submission recorded securely.',
    status: sub.status,
    score,
    passed: score.percentage >= quiz.passingScore,
    passingScore: quiz.passingScore,
    needsReview: !!sub.needsReview,
    late: !!sub.late,
    submittedAt: sub.submittedAt || null,
    result: showAnswers
      ? {
          questions: (sub.questions || []).map((q) => ({
            index: q.questionId,
            type: q.questionType,
            text: q.questionText,
            marks: q.marks,
            marksObtained: q.marksObtained,
            isCorrect: q.isCorrect,
            userAnswer: q.userAnswer === undefined ? null : q.userAnswer,
            correctAnswer: q.correctAnswer === undefined ? null : q.correctAnswer,
            aiFeedback: q.aiFeedback || '',
            needsReview: !!q.needsReview,
          })),
        }
      : null,
  };
};

module.exports = {
  deadlineOf,
  isPastGrace,
  remainingSeconds,
  skeletonFor,
  savedAnswersOf,
  startAttempt,
  saveAnswers,
  submitAttempt,
  finalizeExpired,
  buildResultPayload,
  scoreOf,
  DONE,
};
