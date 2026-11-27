const mongoose = require('mongoose');

const submissionQuestionSchema = new mongoose.Schema({
  // Legacy numeric id = original index of the question inside the quiz.
  questionId: { type: Number },
  // _id of the quiz question this entry belongs to (new; used by autosave).
  questionRef: { type: mongoose.Schema.Types.ObjectId },
  questionText: { type: String },
  questionType: { type: String },
  userAnswer: { type: mongoose.Schema.Types.Mixed },
  correctAnswer: { type: mongoose.Schema.Types.Mixed },
  marks: { type: Number },
  isCorrect: { type: Boolean, default: false },
  marksObtained: { type: Number, default: 0 },
  aiFeedback: { type: String, default: '' },
  needsReview: { type: Boolean, default: false },
  teacherFeedback: { type: String, default: '' },
  manuallyGraded: { type: Boolean, default: false },
});

const suspiciousActivitySchema = new mongoose.Schema({
  imageBase64: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  reason: { type: String, required: true },
});

const submissionSchema = new mongoose.Schema(
  {
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      required: true,
    },
    quizDescription: { type: String },
    userDetails: {
      name: { type: String, required: true },
      email: { type: String, required: true },
      googleId: { type: String, default: null },
      customData: { type: mongoose.Schema.Types.Mixed, default: {} },
    },

    status: {
      type: String,
      enum: ['in-progress', 'submitted', 'abandoned', 'graded'],
      default: 'in-progress',
    },

    startedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date },
    deadlineAt: { type: Date, default: null },
    lastSavedAt: { type: Date, default: null },
    gradedAt: { type: Date, default: null },
    // SHA-256 of the attempt token. Never returned by the API.
    attemptTokenHash: { type: String, select: false },
    needsReview: { type: Boolean, default: false },
    late: { type: Boolean, default: false },

    score: {
      totalMarks: { type: Number, default: 0 },
      obtainedMarks: { type: Number, default: 0 },
      percentage: { type: Number, default: 0 },
    },

    antiCheat: {
      tabSwitches: { type: Number, default: 0 },
      webcamStrikes: { type: Number, default: 0 },
      copyPasteAttempts: { type: Number, default: 0 },
      reloads: { type: Number, default: 0 },
      flagCount: { type: Number, default: 0 },
      isFlagged: { type: Boolean, default: false },
      wasAutoSubmitted: { type: Boolean, default: false },
      identitySwapDetected: { type: Boolean, default: false },
      flaggedImages: [suspiciousActivitySchema],
    },

    questions: [submissionQuestionSchema],
  },
  { timestamps: true }
);

submissionSchema.index({ quizId: 1, 'userDetails.email': 1 }, { unique: true });
submissionSchema.index({ quizId: 1, status: 1, startedAt: -1 });
submissionSchema.index({ 'userDetails.email': 1, status: 1 });
submissionSchema.index({ status: 1, deadlineAt: 1 });

module.exports = mongoose.model('Submission', submissionSchema);
