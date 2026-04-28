const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Generate JWT Token
const generateToken = (userId, role) => {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET, {
    expiresIn: '8h',
  });
};

// @desc    Register a new teacher (Local)
// @route   POST /api/auth/register
// @access  Public
const registerUser = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide all required fields' });
    }

    // Check if user exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      authProvider: 'local',
      isPasswordSet: true,
      role: role || 'teacher',
    });

    if (user) {
      res.status(201).json({
        success: true,
        message: 'User registered successfully. Please login.',
      });
    } else {
      res.status(400).json({ success: false, message: 'Invalid user data' });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Authenticate a user (Local)
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // If user registered via Google and hasn't set a password yet
    if (!user.isPasswordSet) {
      return res.status(401).json({ 
        success: false, 
        message: 'You signed up with Google. Please use Google Login or reset your password.' 
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const token = generateToken(user._id, user.role);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      userId: user._id,
      isPasswordSet: user.isPasswordSet
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Google Login / Signup
// @route   POST /api/auth/google
// @access  Public
const googleAuth = async (req, res, next) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, message: 'Google credential missing' });
    }

    // Verify token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const { email, name, sub: googleId, picture } = payload;

    // Check if user already exists
    let user = await User.findOne({ email });

    if (user) {
      // If user exists but doesn't have a googleId (e.g., originally signed up locally)
      if (!user.googleId) {
        user.googleId = googleId;
        if (!user.profile.avatarUrl) user.profile.avatarUrl = picture;
        await user.save();
      }
    } else {
      // New user signup via Google
      user = await User.create({
        name,
        email,
        googleId,
        authProvider: 'google',
        isPasswordSet: false, // They haven't created a local password yet
        role: 'teacher',
        profile: {
          avatarUrl: picture
        }
      });
    }

    const token = generateToken(user._id, user.role);

    res.status(200).json({
      success: true,
      message: 'Google authentication successful',
      token,
      userId: user._id,
      isPasswordSet: user.isPasswordSet
    });
  } catch (error) {
    console.error('Google Auth Error:', error);
    res.status(401).json({ success: false, message: 'Google authentication failed' });
  }
};

// @desc    Update Teacher Profile & Set Password
// @route   PUT /api/auth/profile
// @access  Private (Teacher)
const updateProfile = async (req, res, next) => {
  try {
    const { name, bio, department, institution, newPassword } = req.body;
    
    // Find user by ID attached from authMiddleware
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Update basic info
    if (name) user.name = name;
    if (bio !== undefined) user.profile.bio = bio;
    if (department !== undefined) user.profile.department = department;
    if (institution !== undefined) user.profile.institution = institution;

    // Handle password creation / update
    if (newPassword) {
      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
      }
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(newPassword, salt);
      user.isPasswordSet = true;
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        name: user.name,
        email: user.email,
        profile: user.profile,
        isPasswordSet: user.isPasswordSet
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Current User Profile
// @route   GET /api/auth/profile
// @access  Private (Teacher)
const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.status(200).json({
      success: true,
      data: {
        name: user.name,
        email: user.email,
        profile: user.profile,
        isPasswordSet: user.isPasswordSet,
        authProvider: user.authProvider
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerUser,
  loginUser,
  googleAuth,
  updateProfile,
  getProfile
};