const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  verifyGoogleAttempt,
  startAttempt,
  flagActivity,
  processSubmission,
  getQuizSubmissions,
  getSubmissionDetails,
  getStudentSubmissions
} = require('../controllers/submitController');

// Public routes for students taking the quiz
router.post('/verify-google', verifyGoogleAttempt);
router.post('/start-attempt', startAttempt);
router.post('/flag', flagActivity); // Asynchronous base64 image logging
router.post('/', processSubmission); // Final submission calculation
router.get('/student/:email', getStudentSubmissions);

// Protected routes for teachers viewing data
router.get('/quiz/:quizId', protect, getQuizSubmissions);
router.get('/details/:submissionId', protect, getSubmissionDetails); // Fetches flagged images

module.exports = router;