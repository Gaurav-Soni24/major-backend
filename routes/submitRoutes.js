const express = require('express');
const { protect, requireStudent, requireAttempt, requireAttemptOrOwnerStudent } = require('../middlewares/authMiddleware');
const c = require('../controllers/submitController');

module.exports = (limiters) => {
  const router = express.Router();

  // Student flow (no account: Google identity -> student token -> attempt token)
  router.post('/verify-google', limiters.google, c.verifyGoogleAttempt);
  router.post('/start-attempt', limiters.startAttempt, requireStudent, c.startAttempt);
  router.post('/flag', limiters.flag, requireAttempt, c.flagActivity);
  router.post('/', requireAttempt, c.processSubmission);
  router.get('/student/:email', requireStudent, c.getStudentSubmissions);

  // Teacher review (Bearer JWT, quiz owner)
  router.get('/quiz/:quizId', protect, c.getQuizSubmissions);
  router.get('/details/:submissionId', protect, c.getSubmissionDetails);
  router.patch('/details/:submissionId/grade', protect, c.gradeSubmission);
  router.delete('/details/:submissionId', protect, c.deleteSubmission);

  // Per-attempt routes (declared last: `/:submissionId/...`)
  router.put('/:submissionId/answers', limiters.answers, requireAttempt, c.saveAnswers);
  router.get('/:submissionId/result', requireAttemptOrOwnerStudent, c.getResult);

  return router;
};
