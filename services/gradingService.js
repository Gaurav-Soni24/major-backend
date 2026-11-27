// Pure grading functions: no database, no network.
const { parseNumeric } = require('../validators/quiz');
const { round2 } = require('../utils/text');

const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const gradeSingle = (q, answer) => {
  const correct = (q.options || []).find((o) => o.isCorrect);
  const correctAnswer = correct ? correct.text : null;
  const ok = typeof answer === 'string' && answer !== '' && answer === correctAnswer;
  return { isCorrect: ok, marksObtained: ok ? q.marks : 0, correctAnswer };
};

// Set equality: same distinct options, no extras, order ignored.
const gradeMultiple = (q, answer) => {
  const correctAnswer = (q.options || []).filter((o) => o.isCorrect).map((o) => o.text);
  let ok = false;
  if (Array.isArray(answer) && answer.length > 0) {
    const a = new Set(answer);
    const c = new Set(correctAnswer);
    ok = a.size === c.size && [...a].every((x) => c.has(x));
  }
  return { isCorrect: ok, marksObtained: ok ? q.marks : 0, correctAnswer };
};

// Numeric compare: "5", "5.0", " 05 " are equal. Tolerance 1e-9.
const gradeInteger = (q, answer) => {
  const correctAnswer = q.correctAnswer;
  const a = isBlank(answer) ? NaN : parseNumeric(answer);
  const c = parseNumeric(correctAnswer);
  const ok = !Number.isNaN(a) && !Number.isNaN(c) && Math.abs(a - c) <= 1e-9;
  return { isCorrect: ok, marksObtained: ok ? q.marks : 0, correctAnswer };
};

const isSubjective = (q) => q.type === 'text' || q.type === 'code';

/**
 * Builds one result record per quiz question (deterministic types graded, subjective ones left at 0
 * and listed in `pending` for the AI). `answers` is a Map(questionIdString -> answer).
 */
const gradeObjectiveAndPlan = (quiz, answers) => {
  const records = [];
  const pending = [];
  quiz.questions.forEach((q, i) => {
    const index = q.originalIndex !== undefined && q.originalIndex !== null ? q.originalIndex : i;
    const key = String(q._id);
    const raw = answers.has(key) ? answers.get(key) : null;
    const userAnswer = isBlank(raw) ? null : raw;
    let g;
    if (q.type === 'single') g = gradeSingle(q, userAnswer);
    else if (q.type === 'multiple') g = gradeMultiple(q, userAnswer);
    else if (q.type === 'integer') g = gradeInteger(q, userAnswer);
    else g = { isCorrect: false, marksObtained: 0, correctAnswer: q.correctAnswer || q.aiGradingRubric || '' };

    records.push({
      questionId: index,
      questionRef: q._id,
      questionText: q.text,
      questionType: q.type,
      userAnswer,
      correctAnswer: g.correctAnswer,
      marks: q.marks,
      isCorrect: g.isCorrect,
      marksObtained: g.marksObtained,
      aiFeedback: '',
      needsReview: false,
      teacherFeedback: '',
      manuallyGraded: false,
    });
    // Blank subjective answers score 0 without spending an AI call.
    if (isSubjective(q) && userAnswer !== null && String(userAnswer).trim() !== '') {
      pending.push({
        index,
        type: q.type,
        question: q.text,
        rubric: q.aiGradingRubric || q.correctAnswer || '',
        maxMarks: q.marks,
        studentAnswer: String(userAnswer),
      });
    }
  });
  return { records, pending };
};

// Merges an aiGrader outcome into the records. Pending questions without a result are marked
// needsReview (they keep 0 marks). Returns the records (mutated) and whether any need review.
const mergeAiResults = (records, pending, aiOutcome) => {
  const results = (aiOutcome && aiOutcome.results) || new Map();
  let needsReview = false;
  for (const item of pending) {
    const rec = records.find((r) => r.questionId === item.index);
    if (!rec) continue;
    const res = results.get(item.index);
    if (res) {
      rec.marksObtained = Math.min(Math.max(res.awardedMarks, 0), rec.marks);
      rec.isCorrect = rec.marksObtained > 0;
      rec.aiFeedback = res.feedback || '';
    } else {
      rec.needsReview = true;
      needsReview = true;
    }
  }
  return { records, needsReview };
};

const computeTotals = (records, passingScore) => {
  const totalMarks = round2(records.reduce((s, r) => s + (Number(r.marks) || 0), 0));
  const obtainedMarks = round2(records.reduce((s, r) => s + (Number(r.marksObtained) || 0), 0));
  const percentage = totalMarks > 0 ? round2((obtainedMarks / totalMarks) * 100) : 0;
  return { totalMarks, obtainedMarks, percentage, passed: passingScore !== undefined ? percentage >= passingScore : undefined };
};

module.exports = {
  isBlank,
  gradeSingle,
  gradeMultiple,
  gradeInteger,
  gradeObjectiveAndPlan,
  mergeAiResults,
  computeTotals,
};
