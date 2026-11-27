const { Issues, isPlainObject, isString, str, bool, int } = require('./common');

const TYPES = ['single', 'multiple', 'text', 'integer', 'code'];
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Parses a number from a number or a numeric string. Returns NaN when it is not a plain finite number.
const parseNumeric = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (!NUM_RE.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

const validateQuestion = (issues, q, i) => {
  const p = `questions[${i}]`;
  if (!isPlainObject(q)) {
    issues.add(p, 'Each question must be an object');
    return null;
  }
  const out = {};
  if (!TYPES.includes(q.type)) {
    issues.add(`${p}.type`, `type must be one of ${TYPES.join(', ')}`);
    return null;
  }
  out.type = q.type;
  out.text = str(issues, q, 'text', { min: 1, max: 4000, required: true, label: `${p}.text` });
  if (typeof q.marks !== 'number' || !Number.isFinite(q.marks) || q.marks <= 0 || q.marks > 100) {
    issues.add(`${p}.marks`, 'marks must be a number greater than 0 and at most 100');
  } else out.marks = q.marks;

  if (q.type === 'single' || q.type === 'multiple') {
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8) {
      issues.add(`${p}.options`, 'options must have between 2 and 8 items');
    } else {
      const seen = new Set();
      const options = [];
      q.options.forEach((o, j) => {
        const op = `${p}.options[${j}]`;
        if (!isPlainObject(o)) return issues.add(op, 'Each option must be an object');
        const text = str(issues, o, 'text', { min: 1, max: 500, required: true, label: `${op}.text` });
        if (o.isCorrect !== undefined && typeof o.isCorrect !== 'boolean') issues.add(`${op}.isCorrect`, 'isCorrect must be true or false');
        if (text !== undefined) {
          if (seen.has(text)) issues.add(`${op}.text`, 'Option text must be unique within the question');
          seen.add(text);
        }
        options.push({ text, isCorrect: o.isCorrect === true });
      });
      const correct = options.filter((o) => o.isCorrect).length;
      if (q.type === 'single' && correct !== 1) issues.add(`${p}.options`, 'A single-choice question needs exactly one correct option');
      if (q.type === 'multiple' && correct < 1) issues.add(`${p}.options`, 'A multiple-choice question needs at least one correct option');
      out.options = options;
    }
  } else if (q.type === 'integer') {
    const n = parseNumeric(q.correctAnswer);
    if (Number.isNaN(n)) issues.add(`${p}.correctAnswer`, 'correctAnswer must be a number');
    else out.correctAnswer = String(typeof q.correctAnswer === 'string' ? q.correctAnswer.trim() : q.correctAnswer);
  } else {
    // text / code: a reference answer or a rubric is required
    const ref = q.correctAnswer !== undefined && q.correctAnswer !== null ? q.correctAnswer : '';
    const rubric = q.aiGradingRubric !== undefined && q.aiGradingRubric !== null ? q.aiGradingRubric : '';
    if (!isString(ref) || !isString(rubric)) {
      issues.add(`${p}.aiGradingRubric`, 'correctAnswer and aiGradingRubric must be strings');
    } else if (!ref.trim() && !rubric.trim()) {
      issues.add(`${p}.aiGradingRubric`, 'Provide an aiGradingRubric or a correctAnswer (reference) for grading');
    } else if (ref.length > 4000 || rubric.length > 4000) {
      issues.add(`${p}.aiGradingRubric`, 'Rubric/reference must be at most 4000 characters');
    } else {
      out.correctAnswer = ref.trim();
      out.aiGradingRubric = rubric.trim();
    }
    if (q.type === 'code') {
      const lang = q.codeLanguage === undefined ? 'javascript' : q.codeLanguage;
      if (!['javascript', 'python'].includes(lang)) issues.add(`${p}.codeLanguage`, 'codeLanguage must be javascript or python');
      else out.codeLanguage = lang;
      const sc = q.starterCode === undefined || q.starterCode === null ? '' : q.starterCode;
      if (!isString(sc) || sc.length > 8000) issues.add(`${p}.starterCode`, 'starterCode must be a string of at most 8000 characters');
      else out.starterCode = sc;
    }
  }
  return out;
};

/**
 * Validates and normalises a quiz payload (create / update). Whitelists fields.
 * `password` is returned as a string or undefined; the controller hashes it.
 */
const validateQuizPayload = (body) => {
  const issues = new Issues();
  const b = isPlainObject(body) ? body : {};
  const out = {};

  out.title = str(issues, b, 'title', { min: 3, max: 120, required: true });
  out.description = b.description === undefined || b.description === null ? '' : str(issues, b, 'description', { max: 1000 });

  if (b.instructions === undefined || b.instructions === null) out.instructions = [];
  else if (!Array.isArray(b.instructions) || b.instructions.length > 20) {
    issues.add('instructions', 'instructions must be an array of at most 20 items');
  } else {
    out.instructions = [];
    b.instructions.forEach((s, i) => {
      if (!isString(s) || s.trim().length === 0 || s.length > 300) issues.add(`instructions[${i}]`, 'Each instruction must be a string of 1-300 characters');
      else out.instructions.push(s.trim());
    });
  }

  if (b.timeLimit === undefined || b.timeLimit === null || b.timeLimit === '') out.timeLimit = null;
  else out.timeLimit = int(issues, b.timeLimit, 'timeLimit', { min: 1, max: 600 });

  if (b.passingScore === undefined || b.passingScore === null) out.passingScore = 60;
  else out.passingScore = int(issues, b.passingScore, 'passingScore', { min: 1, max: 100 });

  if (b.customFields === undefined || b.customFields === null) out.customFields = [];
  else if (!Array.isArray(b.customFields) || b.customFields.length > 5) {
    issues.add('customFields', 'customFields must be an array of at most 5 items');
  } else {
    out.customFields = [];
    const names = new Set();
    b.customFields.forEach((f, i) => {
      const p = `customFields[${i}]`;
      if (!isPlainObject(f)) return issues.add(p, 'Each custom field must be an object');
      const name = str(issues, f, 'name', { min: 1, max: 40, required: true, label: `${p}.name` });
      if (!['text', 'number'].includes(f.type)) issues.add(`${p}.type`, 'type must be text or number');
      if (name !== undefined) {
        // Names become keys of the stored registration data, so they must be safe Mongo keys.
        if (name.startsWith('$') || name.includes('.')) issues.add(`${p}.name`, 'Field names must not start with "$" or contain "."');
        if (names.has(name.toLowerCase())) issues.add(`${p}.name`, 'Custom field names must be unique');
        names.add(name.toLowerCase());
        if (['text', 'number'].includes(f.type)) out.customFields.push({ name, type: f.type });
      }
    });
  }

  // password: undefined = untouched, '' = remove, other string = set
  if (b.password !== undefined && b.password !== null) {
    if (!isString(b.password) || b.password.length > 64) issues.add('password', 'password must be a string of at most 64 characters');
    else out.password = b.password;
  }

  const s = isPlainObject(b.settings) ? b.settings : {};
  if (b.settings !== undefined && b.settings !== null && !isPlainObject(b.settings)) issues.add('settings', 'settings must be an object');
  out.settings = {
    shuffleQuestions: bool(issues, s, 'shuffleQuestions', true, 'settings.shuffleQuestions'),
    shuffleOptions: bool(issues, s, 'shuffleOptions', true, 'settings.shuffleOptions'),
    showAnswers: bool(issues, s, 'showAnswers', false, 'settings.showAnswers'),
  };
  const a = isPlainObject(b.antiCheatSettings) ? b.antiCheatSettings : {};
  if (b.antiCheatSettings !== undefined && b.antiCheatSettings !== null && !isPlainObject(b.antiCheatSettings)) {
    issues.add('antiCheatSettings', 'antiCheatSettings must be an object');
  }
  out.antiCheatSettings = {
    aiCamera: bool(issues, a, 'aiCamera', true, 'antiCheatSettings.aiCamera'),
    tabSwitch: bool(issues, a, 'tabSwitch', true, 'antiCheatSettings.tabSwitch'),
    copyPaste: bool(issues, a, 'copyPaste', true, 'antiCheatSettings.copyPaste'),
    toleranceStrikes:
      a.toleranceStrikes === undefined ? 3 : int(issues, a.toleranceStrikes, 'antiCheatSettings.toleranceStrikes', { min: 1, max: 10 }),
  };

  if (!Array.isArray(b.questions) || b.questions.length < 1 || b.questions.length > 100) {
    issues.add('questions', 'questions must be an array of 1 to 100 items');
  } else {
    out.questions = [];
    b.questions.forEach((q, i) => {
      const v = validateQuestion(issues, q, i);
      if (v) out.questions.push({ ...v, originalIndex: i });
    });
  }

  issues.throwIfAny('Invalid quiz data');
  return out;
};

// Canonical form used to detect whether an update changes the questions.
const canonicalQuestions = (qs) =>
  JSON.stringify(
    (qs || []).map((q) => [
      q.type,
      q.text,
      Number(q.marks),
      (q.options || []).map((o) => [o.text, !!o.isCorrect]),
      q.type === 'integer' ? String(q.correctAnswer ?? '') : q.correctAnswer || '',
      q.aiGradingRubric || '',
      q.type === 'code' ? q.codeLanguage || 'javascript' : '',
      q.type === 'code' ? q.starterCode || '' : '',
    ])
  );

module.exports = { validateQuizPayload, canonicalQuestions, parseNumeric, TYPES };
