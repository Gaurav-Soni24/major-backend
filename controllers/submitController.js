const Quiz = require('../models/Quiz');
const Submission = require('../models/Submission');
const { AppError } = require('../utils/AppError');
const { escapeRegex, round2 } = require('../utils/text');
const { signStudentToken } = require('../services/tokenService');
const { verifyGoogleCredential } = require('../services/googleVerifier');
const attempts = require('../services/attemptService');
const { computeTotals } = require('../services/gradingService');
const { validateCredential } = require('../validators/auth');
const { Issues, isString, isPlainObject, queryString, parsePagination, paginationMeta, assertObjectId } = require('../validators/common');

const NO_IMAGES = '-antiCheat.flaggedImages';
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 400 * 1024;

// ------------------------------------------------------------------ student flow

// @route POST /api/submissions/verify-google  { quizId | "portal-auth", credential }
const verifyGoogleAttempt = async (req, res, next) => {
  try {
    const credential = validateCredential(req.body);
    const quizId = req.body.quizId;
    if (!isString(quizId) || !quizId) throw new AppError(400, 'VALIDATION_ERROR', 'Missing parameters', [{ field: 'quizId', message: 'quizId is required' }]);
    if (quizId !== 'portal-auth') assertObjectId(quizId, 'quizId');

    let payload;
    try {
      payload = await verifyGoogleCredential(credential);
    } catch (err) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid Google authentication.');
    }
    if (!payload || !payload.email || payload.email_verified !== true) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Your Google email is not verified.');
    }
    const email = String(payload.email).toLowerCase();
    const name = (payload.name || email.split('@')[0]).slice(0, 80);
    const studentToken = signStudentToken({ email, name, googleId: payload.sub });
    const identity = { success: true, email, name, googleId: payload.sub, studentToken };

    if (quizId === 'portal-auth') return res.status(200).json({ ...identity, status: 'new' });

    const quiz = await Quiz.findById(quizId).select('timeLimit isPublic');
    if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Assessment not found');

    const existing = await Submission.findOne({ quizId, 'userDetails.email': email }).select('status startedAt deadlineAt');
    if (existing) {
      if (existing.status === 'in-progress' && !attempts.isPastGrace(existing, quiz)) {
        return res.status(200).json({ ...identity, status: 'in-progress', submissionId: existing._id });
      }
      if (existing.status === 'in-progress') await attempts.submitAttempt(existing._id, { auto: true });
      throw new AppError(403, 'ALREADY_SUBMITTED', 'You have already submitted this assessment.');
    }
    res.status(200).json({ ...identity, status: 'new' });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/submissions/start-attempt  (Authorization: Student <token>)
const startAttempt = async (req, res, next) => {
  try {
    const body = isPlainObject(req.body) ? req.body : {};
    assertObjectId(body.quizId, 'quizId');
    if (body.password !== undefined && body.password !== null && !isString(body.password)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid password', [{ field: 'password', message: 'password must be a string' }]);
    }
    const quiz = await Quiz.findById(body.quizId);
    if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Quiz not found');

    // Legacy clients sent userDetails.customData; email and name always come from the verified token.
    const customData = body.customData !== undefined ? body.customData : isPlainObject(body.userDetails) ? body.userDetails.customData : undefined;
    const { submission, token, resumed } = await attempts.startAttempt({
      quiz,
      student: req.student,
      customData,
      password: body.password,
    });

    const now = new Date();
    res.status(200).json({
      success: true,
      submissionId: submission._id,
      attemptToken: token,
      startedAt: submission.startedAt,
      deadlineAt: attempts.deadlineOf(submission, quiz),
      serverTime: now,
      resumed,
      answers: attempts.savedAnswersOf(submission),
      antiCheat: {
        tabSwitches: submission.antiCheat.tabSwitches,
        webcamStrikes: submission.antiCheat.webcamStrikes,
        copyPasteAttempts: submission.antiCheat.copyPasteAttempts,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @route PUT /api/submissions/:submissionId/answers  (X-Attempt-Token)
const saveAnswers = async (req, res, next) => {
  try {
    const quiz = await Quiz.findById(req.submission.quizId);
    if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Quiz not found');
    const out = await attempts.saveAnswers({ submission: req.submission, quiz, answers: req.body.answers, antiCheat: req.body.antiCheat });
    res.status(200).json({ success: true, ...out });
  } catch (error) {
    next(error);
  }
};

// Returns the decoded byte size of a base64 payload after validating its shape.
const checkImage = (value) => {
  if (!isString(value)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid image', [{ field: 'imageBase64', message: 'imageBase64 must be a string' }]);
  const raw = value.replace(/^data:image\/(png|jpe?g|webp);base64,/i, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid image', [{ field: 'imageBase64', message: 'imageBase64 is not valid base64' }]);
  }
  const bytes = Math.floor((raw.length * 3) / 4) - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Image is larger than 400 KB.');
};

// @route POST /api/submissions/flag  { submissionId, imageBase64?, reason }  (X-Attempt-Token)
const flagActivity = async (req, res, next) => {
  try {
    const { imageBase64, reason } = req.body;
    const issues = new Issues();
    if (reason !== undefined && reason !== null && (!isString(reason) || reason.length > 120)) issues.add('reason', 'reason must be a string of at most 120 characters');
    issues.throwIfAny('Invalid data');
    if (imageBase64 !== undefined && imageBase64 !== null && imageBase64 !== '') checkImage(imageBase64);

    const sub = req.submission;
    if (sub.status !== 'in-progress') throw new AppError(409, 'ALREADY_SUBMITTED', 'This attempt is already submitted.');

    // Count every flag; store at most MAX_IMAGES entries (atomic: the push only applies while there is room).
    const counted = await Submission.updateOne(
      { _id: sub._id, status: 'in-progress' },
      { $inc: { 'antiCheat.flagCount': 1 }, $set: { 'antiCheat.isFlagged': true } }
    );
    if (counted.matchedCount === 0) throw new AppError(409, 'ALREADY_SUBMITTED', 'This attempt is already submitted.');
    const pushed = await Submission.updateOne(
      { _id: sub._id, [`antiCheat.flaggedImages.${MAX_IMAGES - 1}`]: { $exists: false } },
      { $push: { 'antiCheat.flaggedImages': { imageBase64: imageBase64 || 'NO_IMAGE', reason: (reason || 'Suspicious Activity').trim() || 'Suspicious Activity', timestamp: new Date() } } }
    );
    res.status(200).json({ success: true, message: 'Activity flagged securely.', stored: pushed.modifiedCount > 0 });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/submissions  { submissionId, answers?, antiCheat? }  (X-Attempt-Token)
const processSubmission = async (req, res, next) => {
  try {
    const { submission, quiz } = await attempts.submitAttempt(req.submission._id, {
      answers: req.body.answers,
      antiCheat: req.body.antiCheat,
    });
    res.status(200).json(attempts.buildResultPayload(submission, quiz));
  } catch (error) {
    next(error);
  }
};

// @route GET /api/submissions/:submissionId/result  (X-Attempt-Token or Student token of the owner)
const getResult = async (req, res, next) => {
  try {
    let sub = req.submission;
    let quiz = await Quiz.findById(sub.quizId);
    if (!quiz) throw new AppError(404, 'NOT_FOUND', 'Quiz not found');
    if (sub.status === 'in-progress') {
      if (!attempts.isPastGrace(sub, quiz)) throw new AppError(409, 'CONFLICT', 'This attempt is still in progress.');
      ({ submission: sub, quiz } = await attempts.submitAttempt(sub._id, { auto: true }));
    }
    res.status(200).json(attempts.buildResultPayload(sub, quiz));
  } catch (error) {
    next(error);
  }
};

// @route GET /api/submissions/student/:email  (Student token for the same email)
const getStudentSubmissions = async (req, res, next) => {
  try {
    const email = String(req.params.email || '').toLowerCase();
    if (email !== req.student.email) throw new AppError(403, 'FORBIDDEN', 'You can only view your own results.');
    const subs = await Submission.find({ 'userDetails.email': email, status: { $in: attempts.DONE } })
      .select('quizId quizDescription status score submittedAt')
      .sort({ submittedAt: -1 })
      .limit(200)
      .lean();
    const quizzes = await Quiz.find({ _id: { $in: subs.map((s) => s.quizId) } }).select('title passingScore').lean();
    const byId = new Map(quizzes.map((q) => [String(q._id), q]));
    res.status(200).json({
      success: true,
      submissions: subs.map((s) => {
        const q = byId.get(String(s.quizId));
        const pct = s.score ? s.score.percentage : 0;
        return {
          _id: s._id,
          quizId: s.quizId,
          quizTitle: (q && q.title) || s.quizDescription || 'Untitled quiz',
          status: s.status,
          score: s.score,
          passed: q ? pct >= q.passingScore : null,
          submittedAt: s.submittedAt,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
};

// ------------------------------------------------------------------ teacher review

const ownedQuizOrForbidden = async (quizId, userId, select) => {
  const quiz = quizId ? await Quiz.findOne({ _id: quizId, userId }).select(select) : null;
  if (!quiz) throw new AppError(403, 'FORBIDDEN', 'Unauthorized access.');
  return quiz;
};

// @route GET /api/submissions/quiz/:quizId?page&limit&status&flagged&search&sort  (owner)
const getQuizSubmissions = async (req, res, next) => {
  try {
    const { quizId } = req.params;
    assertObjectId(quizId, 'quizId');
    const quiz = await ownedQuizOrForbidden(quizId, req.user.userId, 'passingScore');
    await attempts.finalizeExpired({ quizId: quiz._id, limit: 25 });

    const pg = parsePagination(req.query);
    const status = queryString(req.query, 'status', { oneOf: ['all', 'submitted', 'in-progress', 'graded'] }) || 'all';
    const flagged = queryString(req.query, 'flagged', { oneOf: ['true', 'false'] });
    const search = queryString(req.query, 'search', { max: 60 });
    const sortKey = queryString(req.query, 'sort', { oneOf: ['newest', 'score'] }) || 'newest';

    const filter = { quizId: quiz._id };
    if (status !== 'all') filter.status = status;
    if (flagged === 'true') filter['antiCheat.isFlagged'] = true;
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      filter.$or = [{ 'userDetails.name': rx }, { 'userDetails.email': rx }];
    }
    const sort = sortKey === 'score' ? { 'score.percentage': -1, startedAt: -1 } : { startedAt: -1 };

    const [submissions, total, agg] = await Promise.all([
      Submission.find(filter).select(NO_IMAGES).sort(sort).skip(pg.skip).limit(pg.limit).lean(),
      Submission.countDocuments(filter),
      Submission.aggregate([
        { $match: { quizId: quiz._id } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            submitted: { $sum: { $cond: [{ $in: ['$status', attempts.DONE] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in-progress'] }, 1, 0] } },
            flagged: { $sum: { $cond: [{ $eq: ['$antiCheat.isFlagged', true] }, 1, 0] } },
            pctSum: { $sum: { $cond: [{ $in: ['$status', attempts.DONE] }, '$score.percentage', 0] } },
            passed: { $sum: { $cond: [{ $and: [{ $in: ['$status', attempts.DONE] }, { $gte: ['$score.percentage', quiz.passingScore] }] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const s = agg[0] || {};
    const done = s.submitted || 0;
    res.status(200).json({
      success: true,
      submissions,
      pagination: paginationMeta(pg, total),
      summary: {
        count: s.count || 0,
        submitted: done,
        inProgress: s.inProgress || 0,
        flagged: s.flagged || 0,
        avgPercentage: done ? round2(s.pctSum / done) : 0,
        passRate: done ? round2((s.passed / done) * 100) : 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Loads a submission and checks that the teacher owns its quiz (403 otherwise).
const loadOwnedSubmission = async (submissionId, userId, { images = false } = {}) => {
  assertObjectId(submissionId, 'submissionId');
  const q = Submission.findById(submissionId);
  if (!images) q.select(NO_IMAGES);
  const submission = await q;
  if (!submission) throw new AppError(404, 'NOT_FOUND', 'Submission not found');
  const quiz = await Quiz.findOne({ _id: submission.quizId, userId });
  if (!quiz) throw new AppError(403, 'FORBIDDEN', 'You do not have access to this submission.');
  return { submission, quiz };
};

// @route GET /api/submissions/details/:submissionId  (owner)
const getSubmissionDetails = async (req, res, next) => {
  try {
    const { submission, quiz } = await loadOwnedSubmission(req.params.submissionId, req.user.userId, { images: true });
    res.status(200).json({
      success: true,
      submission,
      quiz: { _id: quiz._id, title: quiz.title, passingScore: quiz.passingScore, timeLimit: quiz.timeLimit, antiCheatSettings: quiz.antiCheatSettings },
    });
  } catch (error) {
    next(error);
  }
};

// @route PATCH /api/submissions/details/:submissionId/grade  { questionIndex, marksObtained, feedback? }  (owner)
const gradeSubmission = async (req, res, next) => {
  try {
    const { submission, quiz } = await loadOwnedSubmission(req.params.submissionId, req.user.userId);
    const { questionIndex, marksObtained, feedback } = isPlainObject(req.body) ? req.body : {};
    const issues = new Issues();
    const q = Number.isInteger(questionIndex) ? submission.questions[questionIndex] : undefined;
    if (!q) issues.add('questionIndex', 'questionIndex must be the index of a question in this submission');
    if (typeof marksObtained !== 'number' || !Number.isFinite(marksObtained) || marksObtained < 0) issues.add('marksObtained', 'marksObtained must be a number of 0 or more');
    else if (q && marksObtained > q.marks) issues.add('marksObtained', `marksObtained cannot exceed the question's ${q.marks} marks`);
    if (feedback !== undefined && feedback !== null && (!isString(feedback) || feedback.length > 1000)) issues.add('feedback', 'feedback must be a string of at most 1000 characters');
    issues.throwIfAny('Invalid grade');
    if (!attempts.DONE.includes(submission.status)) throw new AppError(409, 'CONFLICT', 'Only submitted attempts can be graded.');

    const marks = round2(marksObtained);
    const records = submission.questions.map((x, i) => ({
      marks: x.marks,
      marksObtained: i === questionIndex ? marks : x.marksObtained,
      needsReview: i === questionIndex ? false : !!x.needsReview,
    }));
    const totals = computeTotals(records, quiz.passingScore);
    const needsReview = records.some((r) => r.needsReview);
    const prefix = `questions.${questionIndex}`;
    const set = {
      [`${prefix}.marksObtained`]: marks,
      [`${prefix}.isCorrect`]: marks > 0,
      [`${prefix}.needsReview`]: false,
      [`${prefix}.manuallyGraded`]: true,
      score: { totalMarks: totals.totalMarks, obtainedMarks: totals.obtainedMarks, percentage: totals.percentage },
      needsReview,
      status: needsReview ? 'submitted' : 'graded',
      gradedAt: needsReview ? submission.gradedAt || null : new Date(),
    };
    if (feedback !== undefined && feedback !== null) set[`${prefix}.teacherFeedback`] = feedback;
    await Submission.updateOne({ _id: submission._id }, { $set: set });

    res.status(200).json({
      success: true,
      message: 'Grade saved',
      status: set.status,
      needsReview,
      score: set.score,
      passed: totals.percentage >= quiz.passingScore,
    });
  } catch (error) {
    next(error);
  }
};

// @route DELETE /api/submissions/details/:submissionId  (owner)
const deleteSubmission = async (req, res, next) => {
  try {
    const { submission } = await loadOwnedSubmission(req.params.submissionId, req.user.userId);
    await Submission.deleteOne({ _id: submission._id });
    res.status(200).json({ success: true, message: 'Submission deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  verifyGoogleAttempt,
  startAttempt,
  saveAnswers,
  flagActivity,
  processSubmission,
  getResult,
  getStudentSubmissions,
  getQuizSubmissions,
  getSubmissionDetails,
  gradeSubmission,
  deleteSubmission,
};
