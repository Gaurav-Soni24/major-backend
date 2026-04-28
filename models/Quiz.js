const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  isCorrect: { type: Boolean, default: false },
});

const questionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['single', 'multiple', 'text', 'integer', 'code'],
    required: true,
  },
  text: { type: String, required: true },
  marks: { type: Number, required: true, default: 1 },
  options: [optionSchema], 
  correctAnswer: { type: mongoose.Schema.Types.Mixed }, 
  codeLanguage: { type: String, default: 'javascript' }, 
  starterCode: { type: String, default: '' },            
  aiGradingRubric: { type: String, default: '' },        
  originalIndex: { type: Number } 
});

const quizSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    
    // Custom Fields & Security
    customFields: [{
      name: { type: String, required: true },
      type: { type: String, enum: ['text', 'number'], required: true }
    }],
    password: { type: String, default: '' },
    
    instructions: [{ type: String, trim: true }],
    isPublic: { type: Boolean, default: false },
    timeLimit: { type: Number, default: null },
    passingScore: { type: Number, default: 60, min: 1, max: 100 },
    
    settings: {
      shuffleQuestions: { type: Boolean, default: true },
      shuffleOptions: { type: Boolean, default: true },
      showAnswers: { type: Boolean, default: false },
    },
    
    antiCheatSettings: {
      aiCamera: { type: Boolean, default: true },
      tabSwitch: { type: Boolean, default: true },
      copyPaste: { type: Boolean, default: true },
      toleranceStrikes: { type: Number, default: 3 } 
    },
    
    questions: [questionSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Quiz', quizSchema);