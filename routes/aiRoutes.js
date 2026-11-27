const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { generateQuiz, regenerateQuestion } = require('../controllers/aiController');

module.exports = (limiters) => {
  const router = express.Router();

  // Teacher only. The limiter runs after `protect` so it can key on the teacher.
  router.post('/generate-quiz', protect, limiters.ai, generateQuiz);
  router.post('/regenerate-question', protect, limiters.ai, regenerateQuestion);

  return router;
};
