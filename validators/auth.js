const { Issues, isPlainObject, isString, emailRe, str } = require('./common');

const passwordOk = (issues, pw, field = 'password') => {
  if (!isString(pw)) {
    issues.add(field, `${field} is required`);
    return undefined;
  }
  if (pw.length < 8) issues.add(field, `${field} must be at least 8 characters`);
  // bcrypt only uses the first 72 bytes.
  else if (Buffer.byteLength(pw, 'utf8') > 72) issues.add(field, `${field} must be at most 72 bytes`);
  else return pw;
  return undefined;
};

const normEmail = (issues, v, field = 'email') => {
  if (!isString(v) || !v.trim()) {
    issues.add(field, `${field} is required`);
    return undefined;
  }
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !emailRe.test(e)) {
    issues.add(field, 'A valid email is required');
    return undefined;
  }
  return e;
};

const validateRegister = (body) => {
  const issues = new Issues();
  const b = isPlainObject(body) ? body : {};
  const name = str(issues, b, 'name', { min: 2, max: 80, required: true });
  const email = normEmail(issues, b.email);
  const password = passwordOk(issues, b.password);
  issues.throwIfAny();
  // `role` is deliberately not read: new accounts are always teachers.
  return { name, email, password };
};

const validateLogin = (body) => {
  const issues = new Issues();
  const b = isPlainObject(body) ? body : {};
  if (!isString(b.email) || !b.email.trim()) issues.add('email', 'email is required');
  if (!isString(b.password) || !b.password) issues.add('password', 'password is required');
  if (isString(b.email) && b.email.length > 254) issues.add('email', 'email is too long');
  if (isString(b.password) && b.password.length > 1024) issues.add('password', 'password is too long');
  issues.throwIfAny('Please provide email and password');
  return { email: b.email.trim().toLowerCase(), password: b.password };
};

const validateProfileUpdate = (body) => {
  const issues = new Issues();
  const b = isPlainObject(body) ? body : {};
  const out = {};
  if (b.name !== undefined) out.name = str(issues, b, 'name', { min: 2, max: 80 });
  if (b.bio !== undefined) out.bio = str(issues, b, 'bio', { max: 500 });
  if (b.department !== undefined) out.department = str(issues, b, 'department', { max: 100 });
  if (b.institution !== undefined) out.institution = str(issues, b, 'institution', { max: 150 });
  if (b.newPassword !== undefined && b.newPassword !== '') out.newPassword = passwordOk(issues, b.newPassword, 'newPassword');
  if (b.currentPassword !== undefined) {
    if (!isString(b.currentPassword) || b.currentPassword.length > 1024) issues.add('currentPassword', 'currentPassword must be a string');
    else out.currentPassword = b.currentPassword;
  }
  issues.throwIfAny();
  return out;
};

const validateCredential = (body) => {
  const issues = new Issues();
  const b = isPlainObject(body) ? body : {};
  const credential = str(issues, b, 'credential', { min: 1, max: 4096, required: true, trim: false });
  issues.throwIfAny('Google credential missing');
  return credential;
};

module.exports = { validateRegister, validateLogin, validateProfileUpdate, validateCredential, normEmail };
