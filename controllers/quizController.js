const mongoose = require('mongoose');
const Quiz = require('../models/Quiz');
const Submission = require('../models/Submission');
const { AppError } = require('../utils/AppError');
const { shuffle, escapeRegex, round2 } = require('../utils/text');
const { hashQuizPassword } = require('../services/quizPassword');
const { finalizeExpired } = require('../services/attemptService');
const { validateQuizPayload, canonicalQuestions } = require('../validators/quiz');
const { isString, isPlainObject, queryString, parsePagination, paginationMeta, assertObjectId } = require('../validators/common');

const oid = (id) => new mongoose.Types.ObjectId(id);

// Owner-only lookup. Missing and not-yours look identical (404) so existence is not revealed.
const findOwnedQuiz = async (quizId, userId) => {
  assertObjectId(quizId, 'quizId');
  const quiz = await Quiz.findOne({ _id: quizId, userId });
  if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Quiz not found');
  return quiz;
};

// Teacher-facing quiz document: full content (editor needs correct answers) but never the password hash.
const quizForOwner = (quiz) => {
  const o = quiz.toObject ? quiz.toObject() : { ...quiz };
  const hasPassword = !!o.password;
  delete o.password;
  delete o.__v;
  return { ...o, hasPassword, status: o.isPublic ? 'published' : 'draft' };
};

const quizDocFromPayload = (payload, extra = {}) => {
  const { password, ...rest } = payload;
  return { ...rest, ...extra };
};

// @route POST /api/quizzes/create
const createQuiz = async (req, res, next) => {
  try {
    const payload = validateQuizPayload(req.body);
    const hashed = await hashQuizPassword(payload.password);
    const quiz = await Quiz.create(quizDocFromPayload(payload, { userId: req.user.userId, password: hashed }));
    res.status(201).json({ success: true, message: 'Quiz created successfully', quizId: quiz._id });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/quizzes/my-quizzes?page&limit&search&status&sort
const getTeacherQuizzes = async (req, res, next) => {
  try {
    const pg = parsePagination(req.query);
    const search = queryString(req.query, 'search', { max: 80 });
    const status = queryString(req.query, 'status', { oneOf: ['all', 'published', 'draft'] }) || 'all';
    const sortKey = queryString(req.query, 'sort', { oneOf: ['newest', 'oldest', 'title'] }) || 'newest';

    const filter = { userId: oid(req.user.userId) };
    if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };
    if (status === 'published') filter.isPublic = true;
    if (status === 'draft') filter.isPublic = { $ne: true };
    const sort = sortKey === 'oldest' ? { createdAt: 1, _id: 1 } : sortKey === 'title' ? { title: 1, _id: 1 } : { createdAt: -1, _id: -1 };

    const doneStatuses = ['submitted', 'graded'];
    const [rows, total] = await Promise.all([
      Quiz.aggregate([
        { $match: filter },
        { $sort: sort },
        { $skip: pg.skip },
        { $limit: pg.limit },
        {
          $lookup: {
            from: Submission.collection.name,
            localField: '_id',
            foreignField: 'quizId',
            let: { pass: '$passingScore' },
            pipeline: [
              {
                $group: {
                  _id: null,
                  attempts: { $sum: 1 },
                  submitted: { $sum: { $cond: [{ $in: ['$status', doneStatuses] }, 1, 0] } },
                  inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in-progress'] }, 1, 0] } },
                  flagged: { $sum: { $cond: [{ $eq: ['$antiCheat.isFlagged', true] }, 1, 0] } },
                  pctSum: { $sum: { $cond: [{ $in: ['$status', doneStatuses] }, '$score.percentage', 0] } },
                  passed: { $sum: { $cond: [{ $and: [{ $in: ['$status', doneStatuses] }, { $gte: ['$score.percentage', '$$pass'] }] }, 1, 0] } },
                },
              },
            ],
            as: 's',
          },
        },
        {
          $project: {
            title: 1,
            description: 1,
            isPublic: 1,
            timeLimit: 1,
            passingScore: 1,
            createdAt: 1,
            updatedAt: 1,
            questionCount: { $size: { $ifNull: ['$questions', []] } },
            totalMarks: { $sum: '$questions.marks' },
            hasPassword: { $gt: [{ $strLenCP: { $ifNull: ['$password', ''] } }, 0] },
            s: { $arrayElemAt: ['$s', 0] },
          },
        },
      ]),
      Quiz.countDocuments(filter),
    ]);

    const quizzes = rows.map((r) => {
      const s = r.s || {};
      const submitted = s.submitted || 0;
      const { s: _drop, ...q } = r;
      return {
        ...q,
        status: r.isPublic ? 'published' : 'draft',
        stats: {
          attempts: s.attempts || 0,
          submitted,
          inProgress: s.inProgress || 0,
          flagged: s.flagged || 0,
          avgPercentage: submitted ? round2(s.pctSum / submitted) : 0,
          passRate: submitted ? round2((s.passed / submitted) * 100) : 0,
        },
      };
    });

    res.status(200).json({ success: true, quizzes, pagination: paginationMeta(pg, total) });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/quizzes/:quizId  (owner)
const getQuiz = async (req, res, next) => {
  try {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user.userId);
    res.status(200).json({ success: true, quiz: quizForOwner(quiz) });
  } catch (error) {
    next(error);
  }
};

// @route PUT /api/quizzes/:quizId  (owner)
const updateQuiz = async (req, res, next) => {
  try {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user.userId);
    const payload = validateQuizPayload(req.body);

    const submissions = await Submission.countDocuments({ quizId: quiz._id });
    const questionsChanged = canonicalQuestions(payload.questions) !== canonicalQuestions(quiz.questions);
    const timeChanged = (payload.timeLimit ?? null) !== (quiz.timeLimit ?? null);
    const scoreChanged = payload.passingScore !== quiz.passingScore;
    if (submissions > 0 && (questionsChanged || timeChanged || scoreChanged)) {
      throw new AppError(409, 'QUIZ_HAS_SUBMISSIONS', 'This quiz already has submissions: questions, time limit and passing score can no longer be changed.');
    }

    quiz.title = payload.title;
    quiz.description = payload.description;
    quiz.instructions = payload.instructions;
    quiz.customFields = payload.customFields;
    quiz.settings = payload.settings;
    quiz.antiCheatSettings = payload.antiCheatSettings;
    if (payload.password !== undefined) quiz.password = await hashQuizPassword(payload.password);
    if (submissions === 0) {
      quiz.timeLimit = payload.timeLimit;
      quiz.passingScore = payload.passingScore;
      if (questionsChanged) quiz.questions = payload.questions;
    }
    await quiz.save();
    res.status(200).json({ success: true, message: 'Quiz updated successfully', quizId: quiz._id });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/quizzes/:quizId/duplicate  (owner)
const duplicateQuiz = async (req, res, next) => {
  try {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user.userId);
    const o = quiz.toObject();
    const suffix = ' (copy)';
    const copy = await Quiz.create({
      userId: quiz.userId,
      title: o.title.slice(0, 120 - suffix.length) + suffix,
      description: o.description,
      instructions: o.instructions,
      customFields: (o.customFields || []).map((f) => ({ name: f.name, type: f.type })),
      password: o.password || '',
      isPublic: false,
      timeLimit: o.timeLimit,
      passingScore: o.passingScore,
      settings: o.settings,
      antiCheatSettings: o.antiCheatSettings,
      questions: (o.questions || []).map((q, i) => {
        const { _id, ...rest } = q;
        return { ...rest, options: (q.options || []).map(({ text, isCorrect }) => ({ text, isCorrect })), originalIndex: i };
      }),
    });
    res.status(201).json({ success: true, message: 'Quiz duplicated', quizId: copy._id });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/quizzes/toggle-public  { quizId }
const toggleQuizPublic = async (req, res, next) => {
  try {
    const quizId = isPlainObject(req.body) ? req.body.quizId : undefined;
    if (!isString(quizId)) throw new AppError(400, 'VALIDATION_ERROR', 'Valid Quiz ID is required', [{ field: 'quizId', message: 'quizId is required' }]);
    const quiz = await findOwnedQuiz(quizId, req.user.userId);

    if (!quiz.isPublic) {
      // Refuse to publish something that would not pass today's validation (legacy quizzes).
      const o = quiz.toObject();
      validateQuizPayload({ ...o, password: undefined, instructions: o.instructions, questions: o.questions });
    }
    quiz.isPublic = !quiz.isPublic;
    await quiz.save();
    res.status(200).json({ success: true, message: 'Toggle successful', isPublic: quiz.isPublic });
  } catch (error) {
    next(error);
  }
};

// @route DELETE /api/quizzes/:quizId  (owner)
const deleteQuiz = async (req, res, next) => {
  try {
    assertObjectId(req.params.quizId, 'quizId');
    const quiz = await Quiz.findOneAndDelete({ _id: req.params.quizId, userId: req.user.userId });
    if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Quiz not found');
    const del = await Submission.deleteMany({ quizId: quiz._id });
    res.status(200).json({ success: true, message: 'Quiz deleted successfully', deletedSubmissions: del.deletedCount });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/quizzes/public/:quizId
const getPublicQuiz = async (req, res, next) => {
  try {
    const quiz = await Quiz.findById(assertObjectId(req.params.quizId, 'quizId'));
    if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Quiz not found');
    if (!quiz.isPublic) throw new AppError(403, 'QUIZ_NOT_PUBLISHED', 'This quiz is currently private');

    const questions = quiz.questions.map((q) => {
      const out = { _id: q._id, type: q.type, text: q.text, marks: q.marks, originalIndex: q.originalIndex };
      if (q.type === 'code') {
        out.codeLanguage = q.codeLanguage;
        out.starterCode = q.starterCode;
      }
      if (q.type === 'single' || q.type === 'multiple') {
        let opts = q.options.map((o) => ({ _id: o._id, text: o.text }));
        if (quiz.settings && quiz.settings.shuffleOptions) opts = shuffle(opts);
        out.options = opts;
      }
      return out;
    });

    res.status(200).json({
      success: true,
      serverTime: new Date(),
      quiz: {
        _id: quiz._id,
        title: quiz.title,
        description: quiz.description,
        timeLimit: quiz.timeLimit,
        passingScore: quiz.passingScore,
        settings: quiz.settings,
        antiCheatSettings: quiz.antiCheatSettings,
        instructions: quiz.instructions,
        customFields: (quiz.customFields || []).map((f) => ({ name: f.name, type: f.type })),
        isPasswordProtected: !!quiz.password,
        questions,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/quizzes/:quizId/analytics  (owner)
const getQuizAnalytics = async (req, res, next) => {
  try {
    const quiz = await findOwnedQuiz(req.params.quizId, req.user.userId);
    await finalizeExpired({ quizId: quiz._id, limit: 25 });

    const subs = await Submission.find({ quizId: quiz._id, status: { $in: ['submitted', 'graded'] } })
      .select('score startedAt submittedAt questions.questionRef questions.questionId questions.userAnswer questions.marksObtained questions.isCorrect')
      .limit(5000)
      .lean();
    const attempts = await Submission.countDocuments({ quizId: quiz._id });

    const pcts = subs.map((s) => (s.score ? s.score.percentage : 0)).sort((a, b) => a - b);
    const n = pcts.length;
    const sum = pcts.reduce((a, b) => a + b, 0);
    const median = n === 0 ? 0 : n % 2 ? pcts[(n - 1) / 2] : (pcts[n / 2 - 1] + pcts[n / 2]) / 2;
    const durations = subs.filter((s) => s.submittedAt && s.startedAt).map((s) => (new Date(s.submittedAt) - new Date(s.startedAt)) / 1000);

    const dist = Array.from({ length: 10 }, (_, i) => ({ range: i === 9 ? '90-100' : `${i * 10}-${i * 10 + 9}`, count: 0 }));
    for (const p of pcts) dist[Math.min(9, Math.max(0, Math.floor(p / 10)))].count++;

    const qStats = quiz.questions.map((q, i) => ({ q, i, answered: 0, correct: 0, marks: 0 }));
    const byRef = new Map(qStats.map((x) => [String(x.q._id), x]));
    for (const s of subs) {
      for (const sq of s.questions || []) {
        const x = (sq.questionRef && byRef.get(String(sq.questionRef))) || qStats[sq.questionId];
        if (!x) continue;
        const a = sq.userAnswer;
        if (!(a === null || a === undefined || a === '' || (Array.isArray(a) && a.length === 0))) x.answered++;
        if (sq.isCorrect) x.correct++;
        x.marks += sq.marksObtained || 0;
      }
    }

    res.status(200).json({
      success: true,
      summary: {
        attempts,
        submitted: n,
        avgPercentage: n ? round2(sum / n) : 0,
        medianPercentage: round2(median),
        highest: n ? pcts[n - 1] : 0,
        lowest: n ? pcts[0] : 0,
        passRate: n ? round2((pcts.filter((p) => p >= quiz.passingScore).length / n) * 100) : 0,
        avgDurationSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      },
      scoreDistribution: dist,
      questions: qStats.map((x) => ({
        index: x.i,
        _id: x.q._id,
        type: x.q.type,
        text: x.q.text,
        marks: x.q.marks,
        answered: x.answered,
        correctRate: n ? round2((x.correct / n) * 100) : 0,
        avgMarks: n ? round2(x.marks / n) : 0,
      })),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createQuiz,
  getTeacherQuizzes,
  getQuiz,
  updateQuiz,
  duplicateQuiz,
  toggleQuizPublic,
  deleteQuiz,
  getPublicQuiz,
  getQuizAnalytics,
};
