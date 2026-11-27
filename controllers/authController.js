const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { AppError } = require('../utils/AppError');
const { signTeacherToken } = require('../services/tokenService');
const { verifyGoogleCredential } = require('../services/googleVerifier');
const { validateRegister, validateLogin, validateProfileUpdate, validateCredential } = require('../validators/auth');

// Hash compared when the account does not exist, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const INVALID_LOGIN = () => new AppError(401, 'UNAUTHENTICATED', 'Invalid email or password');

// @route POST /api/auth/register  (public)
const registerUser = async (req, res, next) => {
  try {
    const { name, email, password } = validateRegister(req.body);
    if (await User.exists({ email })) throw new AppError(409, 'CONFLICT', 'Email already in use');

    const hashed = await bcrypt.hash(password, 10);
    try {
      // `role` from the body is ignored on purpose: everyone registers as a teacher.
      await User.create({ name, email, password: hashed, authProvider: 'local', isPasswordSet: true, role: 'teacher' });
    } catch (err) {
      if (err && err.code === 11000) throw new AppError(409, 'CONFLICT', 'Email already in use');
      throw err;
    }
    res.status(201).json({ success: true, message: 'User registered successfully. Please login.' });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/auth/login  (public)
const loginUser = async (req, res, next) => {
  try {
    const { email, password } = validateLogin(req.body);
    const user = await User.findOne({ email }).select('+password');
    const hash = user && user.password ? user.password : DUMMY_HASH;
    const match = await bcrypt.compare(password, hash);
    if (!user || !user.password || !user.isPasswordSet || !match) throw INVALID_LOGIN();

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token: signTeacherToken(user._id, user.role),
      userId: user._id,
      isPasswordSet: user.isPasswordSet,
      user: { name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    next(error);
  }
};

// @route POST /api/auth/google  (public)
const googleAuth = async (req, res, next) => {
  try {
    const credential = validateCredential(req.body);
    let payload;
    try {
      payload = await verifyGoogleCredential(credential);
    } catch (err) {
      console.warn('[auth] Google verification failed:', String(err && err.message).slice(0, 120));
      throw new AppError(401, 'UNAUTHENTICATED', 'Google authentication failed');
    }
    if (!payload || !payload.email || payload.email_verified !== true) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Google account email is not verified');
    }
    const email = String(payload.email).toLowerCase();
    const googleId = payload.sub;
    const name = (payload.name || email.split('@')[0]).slice(0, 80);

    let user = await User.findOne({ email });
    if (user) {
      if (!user.googleId) {
        user.googleId = googleId;
        if (!user.profile.avatarUrl && payload.picture) user.profile.avatarUrl = payload.picture;
        await user.save();
      }
    } else {
      user = await User.create({
        name,
        email,
        googleId,
        authProvider: 'google',
        isPasswordSet: false,
        role: 'teacher',
        profile: { avatarUrl: payload.picture || '' },
      });
    }

    res.status(200).json({
      success: true,
      message: 'Google authentication successful',
      token: signTeacherToken(user._id, user.role),
      userId: user._id,
      isPasswordSet: user.isPasswordSet,
      user: { name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    next(error);
  }
};

const profileData = (user) => ({
  name: user.name,
  email: user.email,
  role: user.role,
  profile: user.profile,
  isPasswordSet: user.isPasswordSet,
  authProvider: user.authProvider,
});

// @route PUT /api/auth/profile  (teacher)
const updateProfile = async (req, res, next) => {
  try {
    const input = validateProfileUpdate(req.body);
    const user = await User.findById(req.user.userId).select('+password');
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

    if (input.newPassword) {
      // Changing an existing password requires proving the current one.
      if (user.password) {
        const ok = input.currentPassword ? await bcrypt.compare(input.currentPassword, user.password) : false;
        if (!ok) throw new AppError(403, 'FORBIDDEN', 'Current password is incorrect');
      }
      user.password = await bcrypt.hash(input.newPassword, 10);
      user.isPasswordSet = true;
    }
    if (input.name) user.name = input.name;
    if (input.bio !== undefined) user.profile.bio = input.bio;
    if (input.department !== undefined) user.profile.department = input.department;
    if (input.institution !== undefined) user.profile.institution = input.institution;
    await user.save();

    res.status(200).json({ success: true, message: 'Profile updated successfully', data: profileData(user) });
  } catch (error) {
    next(error);
  }
};

// @route GET /api/auth/profile  (teacher)
const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.status(200).json({ success: true, data: profileData(user) });
  } catch (error) {
    next(error);
  }
};

module.exports = { registerUser, loginUser, googleAuth, updateProfile, getProfile };
