const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { generateQuiz, regenerateQuestion } = require('../controllers/aiController');

// All AI routes are protected (Teacher only)
router.post('/generate-quiz', protect, generateQuiz);
router.post('/regenerate-question', protect, regenerateQuestion); // NEW: Single question regeneration

module.exports = router;