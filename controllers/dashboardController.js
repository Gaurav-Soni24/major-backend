const mongoose = require('mongoose');
const Quiz = require('../models/Quiz');
const Submission = require('../models/Submission');
const { round2 } = require('../utils/text');

const DONE = ['submitted', 'graded'];
const DAY = 24 * 60 * 60 * 1000;

const dayKey = (d) => d.toISOString().slice(0, 10);

// @route GET /api/dashboard/summary  (teacher)
const getDashboardSummary = async (req, res, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.userId);
    const quizzes = await Quiz.find({ userId }).select('title isPublic createdAt').sort({ createdAt: -1 }).lean();
    const quizIds = quizzes.map((q) => q._id);
    const titleById = new Map(quizzes.map((q) => [String(q._id), q.title]));

    const since = new Date(Date.now() - 13 * DAY);
    since.setUTCHours(0, 0, 0, 0);

    const [totalsAgg, attemptsPerQuiz, startedAgg, submittedAgg, recent] = await Promise.all([
      Submission.aggregate([
        { $match: { quizId: { $in: quizIds } } },
        { $lookup: { from: Quiz.collection.name, localField: 'quizId', foreignField: '_id', pipeline: [{ $project: { passingScore: 1 } }], as: 'q' } },
        { $addFields: { pass: { $ifNull: [{ $arrayElemAt: ['$q.passingScore', 0] }, 60] } } },
        {
          $group: {
            _id: null,
            attempts: { $sum: 1 },
            submitted: { $sum: { $cond: [{ $in: ['$status', DONE] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in-progress'] }, 1, 0] } },
            flagged: { $sum: { $cond: [{ $eq: ['$antiCheat.isFlagged', true] }, 1, 0] } },
            pctSum: { $sum: { $cond: [{ $in: ['$status', DONE] }, '$score.percentage', 0] } },
            passed: { $sum: { $cond: [{ $and: [{ $in: ['$status', DONE] }, { $gte: ['$score.percentage', '$pass'] }] }, 1, 0] } },
          },
        },
      ]),
      Submission.aggregate([{ $match: { quizId: { $in: quizIds } } }, { $group: { _id: '$quizId', attempts: { $sum: 1 } } }]),
      Submission.aggregate([
        { $match: { quizId: { $in: quizIds }, startedAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: 'UTC' } }, n: { $sum: 1 } } },
      ]),
      Submission.aggregate([
        { $match: { quizId: { $in: quizIds }, status: { $in: DONE }, submittedAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$submittedAt', timezone: 'UTC' } }, n: { $sum: 1 } } },
      ]),
      Submission.find({ quizId: { $in: quizIds } })
        .select('quizId userDetails.name userDetails.email status score.percentage submittedAt startedAt antiCheat.isFlagged')
        .sort({ startedAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const t = totalsAgg[0] || {};
    const submitted = t.submitted || 0;
    const published = quizzes.filter((q) => q.isPublic).length;

    const startedBy = new Map(startedAgg.map((r) => [r._id, r.n]));
    const submittedBy = new Map(submittedAgg.map((r) => [r._id, r.n]));
    const activity = [];
    for (let i = 13; i >= 0; i--) {
      const key = dayKey(new Date(Date.now() - i * DAY));
      activity.push({ date: key, attempts: startedBy.get(key) || 0, submitted: submittedBy.get(key) || 0 });
    }

    const attemptsById = new Map(attemptsPerQuiz.map((r) => [String(r._id), r.attempts]));
    res.status(200).json({
      success: true,
      totals: {
        quizzes: quizzes.length,
        published,
        drafts: quizzes.length - published,
        attempts: t.attempts || 0,
        submitted,
        inProgress: t.inProgress || 0,
        flagged: t.flagged || 0,
        avgPercentage: submitted ? round2(t.pctSum / submitted) : 0,
        passRate: submitted ? round2((t.passed / submitted) * 100) : 0,
      },
      activity,
      recentSubmissions: recent.map((s) => ({
        _id: s._id,
        quizId: s.quizId,
        quizTitle: titleById.get(String(s.quizId)) || '',
        name: s.userDetails.name,
        email: s.userDetails.email,
        status: s.status,
        percentage: s.score ? s.score.percentage : 0,
        submittedAt: s.submittedAt || null,
        isFlagged: !!(s.antiCheat && s.antiCheat.isFlagged),
      })),
      recentQuizzes: quizzes.slice(0, 5).map((q) => ({
        _id: q._id,
        title: q.title,
        isPublic: !!q.isPublic,
        createdAt: q.createdAt,
        attempts: attemptsById.get(String(q._id)) || 0,
      })),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getDashboardSummary };
