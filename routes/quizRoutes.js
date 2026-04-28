const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  createQuiz,
  getTeacherQuizzes,
  toggleQuizPublic,
  deleteQuiz,
  getPublicQuiz
} = require('../controllers/quizController');

// Public routes
router.get('/public/:quizId', getPublicQuiz);

// Protected routes (Require Teacher JWT)
router.post('/create', protect, createQuiz);
router.get('/my-quizzes', protect, getTeacherQuizzes);
router.post('/toggle-public', protect, toggleQuizPublic);
router.delete('/:quizId', protect, deleteQuiz);

module.exports = router;