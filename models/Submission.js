const mongoose = require('mongoose');

const submissionQuestionSchema = new mongoose.Schema({
  questionId: { type: Number },
  questionText: { type: String },
  questionType: { type: String },
  userAnswer: { type: mongoose.Schema.Types.Mixed },
  correctAnswer: { type: mongoose.Schema.Types.Mixed },
  marks: { type: Number },
  isCorrect: { type: Boolean, default: false },
  marksObtained: { type: Number, default: 0 },
  aiFeedback: { type: String, default: '' },
});

const suspiciousActivitySchema = new mongoose.Schema({
  imageBase64: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  reason: { type: String, required: true }
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
      customData: { type: mongoose.Schema.Types.Mixed, default: {} } // Stores custom fields
    },
    
    status: {
      type: String,
      enum: ['in-progress', 'submitted', 'abandoned', 'graded'],
      default: 'in-progress'
    },
    
    startedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date },
    
    score: {
      totalMarks: { type: Number, default: 0 },
      obtainedMarks: { type: Number, default: 0 },
      percentage: { type: Number, default: 0 },
    },
    
    antiCheat: {
      tabSwitches: { type: Number, default: 0 },
      webcamStrikes: { type: Number, default: 0 },
      copyPasteAttempts: { type: Number, default: 0 },
      isFlagged: { type: Boolean, default: false },
      wasAutoSubmitted: { type: Boolean, default: false },
      identitySwapDetected: { type: Boolean, default: false },
      flaggedImages: [suspiciousActivitySchema]
    },
    
    questions: [submissionQuestionSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Submission', submissionSchema);