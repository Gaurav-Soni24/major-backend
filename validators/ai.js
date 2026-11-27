const { Issues, isPlainObject, isString, str } = require('./common');

const COUNT_KEYS = ['single', 'multiple', 'integer', 'text', 'code'];

const validateGenerate = (body) => {
  const issues = new Issues();
  const b = isPlainObject(body) ? body : {};
  const syllabus = str(issues, b, 'syllabus', { min: 3, max: 5000, required: true });
  const difficulty = str(issues, b, 'difficulty', { min: 1, max: 30, required: true });
  const field = b.field === undefined ? undefined : str(issues, b, 'field', { max: 100 });
  let totalMarks;
  if (b.totalMarks !== undefined && b.totalMarks !== null && b.totalMarks !== '') {
    totalMarks = Number(b.totalMarks);
    if (!Number.isFinite(totalMarks) || totalMarks <= 0 || totalMarks > 10000) issues.add('totalMarks', 'totalMarks must be a positive number');
  }
  const counts = {};
  if (!isPlainObject(b.questionCounts)) issues.add('questionCounts', 'questionCounts is required');
  else {
    let sum = 0;
    for (const k of COUNT_KEYS) {
      const v = b.questionCounts[k] === undefined || b.questionCounts[k] === '' ? 0 : Number(b.questionCounts[k]);
      if (!Number.isInteger(v) || v < 0 || v > 50) issues.add(`questionCounts.${k}`, 'Must be an integer between 0 and 50');
      else {
        counts[k] = v;
        sum += v;
      }
    }
    if (sum < 1 || sum > 100) issues.add('questionCounts', 'Request between 1 and 100 questions in total');
  }
  issues.throwIfAny('Syllabus, difficulty, and question counts are required.');
  return { syllabus, difficulty, field, totalMarks, questionCounts: counts };
};

const validateRegenerate = (body) => {
  const issues = new Issues();
  const b = isPlainObject(body) ? body : {};
  const syllabus = str(issues, b, 'syllabus', { min: 3, max: 5000, required: true });
  const difficulty = str(issues, b, 'difficulty', { min: 1, max: 30, required: true });
  const field = b.field === undefined ? undefined : str(issues, b, 'field', { max: 100 });
  if (!isString(b.type) || !COUNT_KEYS.includes(b.type)) issues.add('type', 'type must be a valid question type');
  issues.throwIfAny();
  return { syllabus, difficulty, field, type: b.type };
};

module.exports = { validateGenerate, validateRegenerate };
