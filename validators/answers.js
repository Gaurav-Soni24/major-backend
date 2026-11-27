const { Issues, isPlainObject, isString, isObjectId } = require('./common');
const { AppError } = require('../utils/AppError');

const LIMITS = { single: 500, text: 10000, code: 20000, integer: 40, option: 500 };

const emptyAnswer = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// Checks one answer's shape for the question type. Returns the cleaned value (null = cleared)
// or undefined after recording an issue.
const cleanAnswer = (type, v, field, issues) => {
  if (emptyAnswer(v)) return null;
  const bad = (msg) => {
    issues.add(field, msg);
    return undefined;
  };
  switch (type) {
    case 'single':
      if (!isString(v) || v.length > LIMITS.single) return bad('Answer must be a string (option text)');
      return v;
    case 'multiple':
      if (!Array.isArray(v) || v.length > 8 || !v.every((x) => isString(x) && x.length <= LIMITS.option)) {
        return bad('Answer must be an array of at most 8 option texts');
      }
      return Array.from(new Set(v));
    case 'integer':
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (!isString(v) || v.length > LIMITS.integer) return bad('Answer must be a number');
      return v;
    case 'text':
    case 'code':
      if (!isString(v) || v.length > LIMITS[type]) return bad(`Answer must be a string of at most ${LIMITS[type]} characters`);
      return v;
    default:
      return bad('Unknown question type');
  }
};

/**
 * Validates an `answers` array against a quiz. Matches by question _id (`questionId`), falling back
 * to the legacy numeric original index. Answers for unknown questions are ignored.
 * Returns a Map(questionIdString -> cleaned answer).
 */
const validateAnswers = (answers, quiz) => {
  if (answers === undefined || answers === null) return new Map();
  if (!Array.isArray(answers) || answers.length > 100) {
    throw new AppError(400, 'VALIDATION_ERROR', 'answers must be an array of at most 100 items', [
      { field: 'answers', message: 'Invalid answers array' },
    ]);
  }
  const issues = new Issues();
  const byId = new Map(quiz.questions.map((q, i) => [String(q._id), q]));
  const byIndex = new Map(
    quiz.questions.map((q, i) => [q.originalIndex !== undefined && q.originalIndex !== null ? q.originalIndex : i, q])
  );
  const out = new Map();
  answers.forEach((a, n) => {
    const field = `answers[${n}]`;
    if (!isPlainObject(a)) return issues.add(field, 'Each answer must be an object');
    let q;
    if (isObjectId(a.questionId)) q = byId.get(String(a.questionId));
    else if (Number.isInteger(a.originalIndex)) q = byIndex.get(a.originalIndex);
    else if (Number.isInteger(a.questionId)) q = byIndex.get(a.questionId);
    else return issues.add(`${field}.questionId`, 'questionId must be a question id');
    if (!q) return; // not a question of this quiz: ignored
    const cleaned = cleanAnswer(q.type, a.userAnswer, `${field}.userAnswer`, issues);
    if (cleaned !== undefined) out.set(String(q._id), cleaned);
  });
  issues.throwIfAny('Invalid answers');
  return out;
};

const validateAntiCheat = (ac) => {
  if (ac === undefined || ac === null) return {};
  if (!isPlainObject(ac)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'antiCheat must be an object', [{ field: 'antiCheat', message: 'antiCheat must be an object' }]);
  }
  const out = {};
  for (const k of ['tabSwitches', 'webcamStrikes', 'copyPasteAttempts']) {
    if (ac[k] === undefined) continue;
    if (!Number.isInteger(ac[k]) || ac[k] < 0 || ac[k] > 100000) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid antiCheat counters', [
        { field: `antiCheat.${k}`, message: 'Must be a non-negative integer' },
      ]);
    }
    out[k] = ac[k];
  }
  for (const k of ['isFlagged', 'wasAutoSubmitted', 'identitySwapDetected']) {
    if (ac[k] !== undefined) out[k] = ac[k] === true;
  }
  return out;
};

module.exports = { validateAnswers, validateAntiCheat, emptyAnswer };
