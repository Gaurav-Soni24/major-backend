const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const {
  createQuiz,
  getTeacherQuizzes,
  getQuiz,
  updateQuiz,
  duplicateQuiz,
  toggleQuizPublic,
  deleteQuiz,
  getPublicQuiz,
  getQuizAnalytics,
} = require('../controllers/quizController');

module.exports = () => {
  const router = express.Router();

  // Public
  router.get('/public/:quizId', getPublicQuiz);

  // Teacher (Bearer JWT). Fixed paths are declared before `/:quizId`.
  router.post('/create', protect, createQuiz);
  router.get('/my-quizzes', protect, getTeacherQuizzes);
  router.post('/toggle-public', protect, toggleQuizPublic);
  router.get('/:quizId/analytics', protect, getQuizAnalytics);
  router.post('/:quizId/duplicate', protect, duplicateQuiz);
  router.get('/:quizId', protect, getQuiz);
  router.put('/:quizId', protect, updateQuiz);
  router.delete('/:quizId', protect, deleteQuiz);

  return router;
};
