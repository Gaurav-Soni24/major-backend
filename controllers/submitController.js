const mongoose = require('mongoose'); 
const { OAuth2Client } = require('google-auth-library');
const Quiz = require('../models/Quiz');
const Submission = require('../models/Submission');
const { gradeAnswersWithAI } = require('./aiController');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const verifyGoogleAttempt = async (req, res, next) => {
  try {
    const { quizId, credential } = req.body;
    if (!quizId || !credential) return res.status(400).json({ success: false, message: 'Missing parameters' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential, audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;

    if (quizId === 'portal-auth') {
       return res.status(200).json({ success: true, email, name: payload.name });
    }

    if (!mongoose.isValidObjectId(quizId)) return res.status(400).json({ success: false, message: 'Invalid Assessment ID.' });

    // CRITICAL: Checks if the user already has a submission record (even if 'in-progress' / abandoned)
    const existingSubmission = await Submission.findOne({ quizId, 'userDetails.email': email });
    if (existingSubmission) {
      return res.status(403).json({ 
        success: false, 
        message: 'Security Alert: You have already started this assessment. Reloading or leaving the page is not permitted. You cannot attempt it again.' 
      });
    }

    res.status(200).json({ success: true, email, name: payload.name, googleId: payload.sub, status: 'new' });
  } catch (error) {
    res.status(401).json({ success: false, message: 'Invalid Google authentication.' });
  }
};

const startAttempt = async (req, res, next) => {
  try {
    const { quizId, userDetails, password } = req.body;

    if (!quizId || !mongoose.isValidObjectId(quizId) || !userDetails || !userDetails.email) {
      return res.status(400).json({ success: false, message: 'Missing or invalid parameters' });
    }

    const quiz = await Quiz.findById(quizId);
    if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found' });

    if (quiz.password && quiz.password !== password) {
       return res.status(401).json({ success: false, message: 'Incorrect quiz password.' });
    }

    let submission = await Submission.findOne({ quizId, 'userDetails.email': userDetails.email });

    // CRITICAL: Create the record instantly in the DB so they are tracked the second they start the timer
    if (!submission) {
      submission = await Submission.create({
        quizId,
        quizDescription: quiz.title,
        userDetails, 
        status: 'in-progress',
        startedAt: new Date()
      });
    }

    res.status(200).json({ success: true, submissionId: submission._id });
  } catch (error) {
    next(error);
  }
};

const flagActivity = async (req, res, next) => {
  try {
    const { submissionId, imageBase64, reason } = req.body;
    if (!submissionId || !mongoose.isValidObjectId(submissionId)) return res.status(400).json({ success: false, message: 'Invalid data' });

    await Submission.findByIdAndUpdate(submissionId, {
      $push: {
        'antiCheat.flaggedImages': {
          imageBase64: imageBase64 || 'NO_IMAGE', reason: reason || 'Suspicious Activity', timestamp: new Date()
        }
      },
      $set: { 'antiCheat.isFlagged': true }
    });

    res.status(200).json({ success: true, message: 'Activity flagged securely.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to flag activity.' });
  }
};

const processSubmission = async (req, res, next) => {
  try {
    const { submissionId, answers, antiCheat } = req.body;

    if (!submissionId || !mongoose.isValidObjectId(submissionId) || !answers) {
      return res.status(400).json({ success: false, message: 'Invalid required submission data.' });
    }

    const submission = await Submission.findById(submissionId);
    if (!submission || submission.status === 'submitted') {
      return res.status(400).json({ success: false, message: 'Invalid or already submitted session.' });
    }

    const quiz = await Quiz.findById(submission.quizId);
    if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found.' });

    let totalMaxMarks = 0;
    let autoObtainedMarks = 0;
    const processedQuestions = [];
    const manualGradeQuestions = [];

    quiz.questions.forEach((q, index) => {
      totalMaxMarks += q.marks;
      
      // FIX: Match by questionId first (safest), fallback to DB's originalIndex, or array index if DB is missing it
      const actualOriginalIndex = q.originalIndex !== undefined ? q.originalIndex : index;
      const studentAnsObj = answers.find(a => 
        (a.questionId && q._id && String(a.questionId) === String(q._id)) || 
        (a.originalIndex === actualOriginalIndex)
      );

      // Safely extract the answer, ensuring we handle empty strings correctly vs completely missing
      const studentAns = (studentAnsObj && studentAnsObj.userAnswer !== undefined) 
                          ? studentAnsObj.userAnswer 
                          : null;

      let isCorrect = false;
      let marksObtained = 0;
      let correctAnswer;

      if (q.type === 'single') {
        const correctOpt = q.options.find(o => o.isCorrect);
        correctAnswer = correctOpt ? correctOpt.text : null;
        if (studentAns !== null && studentAns !== "" && studentAns === correctAnswer) { 
          isCorrect = true; 
          marksObtained = q.marks; 
        }
      } else if (q.type === 'multiple') {
        const correctOpts = q.options.filter(o => o.isCorrect).map(o => o.text);
        correctAnswer = correctOpts;
        if (Array.isArray(studentAns) && studentAns.length > 0 && studentAns.length === correctOpts.length && studentAns.every(val => correctOpts.includes(val))) {
          isCorrect = true; marksObtained = q.marks;
        }
      } else if (q.type === 'integer') {
        correctAnswer = q.correctAnswer;
        if (studentAns !== null && studentAns !== "" && String(studentAns).trim() === String(correctAnswer).trim()) {
          isCorrect = true; marksObtained = q.marks;
        }
      } else {
        correctAnswer = q.correctAnswer || q.aiGradingRubric;
        manualGradeQuestions.push({
          questionId: actualOriginalIndex, 
          questionType: q.type, questionText: q.text,
          studentAnswer: studentAns, correctAnswerRubric: correctAnswer, maxMarks: q.marks
        });
      }

      autoObtainedMarks += marksObtained;
      processedQuestions.push({
        questionId: actualOriginalIndex, questionText: q.text, questionType: q.type,
        userAnswer: studentAns, correctAnswer: correctAnswer, marks: q.marks,
        isCorrect: isCorrect, marksObtained: marksObtained, aiFeedback: ''
      });
    });

    let aiObtainedMarks = 0;
    if (manualGradeQuestions.length > 0) {
      const aiResults = await gradeAnswersWithAI(manualGradeQuestions);
      if (Array.isArray(aiResults)) {
        aiResults.forEach(aiGrade => {
          const pqIndex = processedQuestions.findIndex(pq => pq.questionId === aiGrade.questionId);
          if (pqIndex !== -1) {
            processedQuestions[pqIndex].marksObtained = aiGrade.awardedMarks || 0;
            processedQuestions[pqIndex].isCorrect = aiGrade.awardedMarks > 0;
            processedQuestions[pqIndex].aiFeedback = aiGrade.feedback || '';
            aiObtainedMarks += (aiGrade.awardedMarks || 0);
          }
        });
      }
    }

    const totalObtainedMarks = autoObtainedMarks + aiObtainedMarks;
    const percentage = totalMaxMarks > 0 ? parseFloat(((totalObtainedMarks / totalMaxMarks) * 100).toFixed(2)) : 0;

    submission.status = 'submitted';
    submission.submittedAt = new Date();
    submission.score = { totalMarks: totalMaxMarks, obtainedMarks: totalObtainedMarks, percentage: percentage };
    
    const safeAC = antiCheat || {};
    const updateData = {
      status: submission.status,
      submittedAt: submission.submittedAt,
      score: submission.score,
      questions: processedQuestions,
      'antiCheat.tabSwitches': Math.max(submission.antiCheat?.tabSwitches || 0, safeAC.tabSwitches || 0),
      'antiCheat.webcamStrikes': Math.max(submission.antiCheat?.webcamStrikes || 0, safeAC.webcamStrikes || 0),
      'antiCheat.copyPasteAttempts': Math.max(submission.antiCheat?.copyPasteAttempts || 0, safeAC.copyPasteAttempts || 0),
      'antiCheat.wasAutoSubmitted': safeAC.wasAutoSubmitted || false,
      'antiCheat.identitySwapDetected': safeAC.identitySwapDetected || false,
    };

    if (safeAC.isFlagged || submission.antiCheat?.flaggedImages?.length > 0) {
       updateData['antiCheat.isFlagged'] = true;
    }

    await Submission.findByIdAndUpdate(submissionId, { $set: updateData });

    res.status(200).json({ success: true, message: 'Submission recorded securely.', score: submission.score });
  } catch (error) {
    next(error);
  }
};

const getQuizSubmissions = async (req, res, next) => {
  try {
    const { quizId } = req.params;
    if (!quizId || !mongoose.isValidObjectId(quizId)) return res.status(400).json({ success: false, message: 'Invalid Assessment ID.' });
    
    const quiz = await Quiz.findOne({ _id: quizId, userId: req.user.userId });
    if (!quiz) return res.status(403).json({ success: false, message: 'Unauthorized access.' });

    // CRITICAL: Sorting by startedAt instead of submittedAt so "in-progress" / abandoned attempts show at the top 
    const submissions = await Submission.find({ quizId }).select('-antiCheat.flaggedImages').sort({ startedAt: -1 });
    res.status(200).json({ success: true, submissions });
  } catch (error) {
    next(error);
  }
};

const getSubmissionDetails = async (req, res, next) => {
  try {
    const { submissionId } = req.params;
    if (!submissionId || !mongoose.isValidObjectId(submissionId)) return res.status(400).json({ success: false, message: 'Invalid ID.' });

    const submission = await Submission.findById(submissionId).populate('quizId');
    if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });
    
    res.status(200).json({ success: true, submission });
  } catch (error) {
    next(error);
  }
};

const getStudentSubmissions = async (req, res, next) => {
  try {
    const { email } = req.params;
    const submissions = await Submission.find({ 
      'userDetails.email': email,
      status: { $in: ['submitted', 'graded'] }
    }).select('-antiCheat.flaggedImages').sort({ submittedAt: -1 });
                                        
    if (!submissions || submissions.length === 0) return res.status(404).json({ success: false, message: 'No submissions found.' });

    res.status(200).json({ success: true, submissions });
  } catch (error) {
    next(error);
  }
};

module.exports = { verifyGoogleAttempt, startAttempt, flagActivity, processSubmission, getQuizSubmissions, getSubmissionDetails, getStudentSubmissions };