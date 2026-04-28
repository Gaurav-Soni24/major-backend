const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { 
  registerUser, 
  loginUser, 
  googleAuth, 
  updateProfile, 
  getProfile 
} = require('../controllers/authController');

// Public Auth Routes
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/google', googleAuth);

// Protected Profile Routes (Require Teacher JWT)
router.get('/profile', protect, getProfile);
router.put('/profile', protect, updateProfile);

module.exports = router;