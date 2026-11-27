const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide a name'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
        'Please provide a valid email',
      ],
    },
    password: {
      type: String,
      // Removed 'required: true' to accommodate users signing up via Google Auth
      minlength: 8,
      select: false, 
    },
    googleId: {
      type: String,
      default: null,
      sparse: true // Allows multiple users to safely have a null googleId
    },
    authProvider: {
      type: String,
      enum: ['local', 'google'],
      default: 'local'
    },
    isPasswordSet: {
      type: Boolean,
      default: true // Will be set to false if a user registers via Google and skips password creation
    },
    role: {
      type: String,
      enum: ['teacher', 'admin'],
      default: 'teacher',
    },
    // New profile section for the teacher dashboard
    profile: {
      bio: { type: String, default: '' },
      department: { type: String, default: '' },
      institution: { type: String, default: '' },
      avatarUrl: { type: String, default: '' }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);