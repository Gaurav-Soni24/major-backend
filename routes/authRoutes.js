const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { registerUser, loginUser, googleAuth, updateProfile, getProfile } = require('../controllers/authController');

module.exports = (limiters) => {
  const router = express.Router();

  // Public
  router.post('/register', limiters.auth, registerUser);
  router.post('/login', limiters.auth, loginUser);
  router.post('/google', limiters.google, googleAuth);

  // Teacher (Bearer JWT)
  router.get('/profile', protect, getProfile);
  router.put('/profile', protect, updateProfile);

  return router;
};
