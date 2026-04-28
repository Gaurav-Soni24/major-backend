const Quiz = require('../models/Quiz');
const mongoose = require('mongoose');

const createQuiz = async (req, res, next) => {
  try {
    const { title, description, timeLimit, passingScore, settings, antiCheatSettings, questions, instructions, customFields, password } = req.body;

    if (!title || !questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid quiz data structure' });
    }

    const quiz = await Quiz.create({
      userId: req.user.userId,
      title,
      description,
      instructions: instructions || [],
      customFields: customFields || [],
      password: password || '',
      timeLimit,
      passingScore,
      settings: {
        shuffleQuestions: settings?.shuffleQuestions ?? true,
        shuffleOptions: settings?.shuffleOptions ?? true,
        showAnswers: settings?.showAnswers ?? false
      },
      antiCheatSettings,
      questions
    });

    res.status(201).json({ success: true, message: 'Quiz created successfully', quizId: quiz._id });
  } catch (error) {
    next(error);
  }
};

const getTeacherQuizzes = async (req, res, next) => {
  try {
    const quizzes = await Quiz.find({ userId: req.user.userId })
                              .select('-questions')
                              .sort({ createdAt: -1 });
    res.status(200).json({ success: true, quizzes });
  } catch (error) {
    next(error);
  }
};

const toggleQuizPublic = async (req, res, next) => {
  try {
    const { quizId } = req.body;
    if (!quizId || !mongoose.isValidObjectId(quizId)) {
      return res.status(400).json({ success: false, message: 'Valid Quiz ID is required' });
    }

    const quiz = await Quiz.findOne({ _id: quizId, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found or unauthorized' });

    quiz.isPublic = !quiz.isPublic;
    await quiz.save();

    res.status(200).json({ success: true, message: 'Toggle successful', isPublic: quiz.isPublic });
  } catch (error) {
    next(error);
  }
};

const deleteQuiz = async (req, res, next) => {
  try {
    const { quizId } = req.params;
    if (!quizId || !mongoose.isValidObjectId(quizId)) {
      return res.status(400).json({ success: false, message: 'Valid Quiz ID is required' });
    }

    const quiz = await Quiz.findOneAndDelete({ _id: quizId, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found or unauthorized' });

    res.status(200).json({ success: true, message: 'Quiz deleted successfully' });
  } catch (error) {
    next(error);
  }
};

const getPublicQuiz = async (req, res, next) => {
  try {
    const { quizId } = req.params;
    if (!quizId || !mongoose.isValidObjectId(quizId)) {
      return res.status(400).json({ success: false, message: 'Invalid Quiz ID provided.' });
    }

    const quiz = await Quiz.findById(quizId);

    if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found' });
    if (!quiz.isPublic) return res.status(403).json({ success: false, message: 'This quiz is currently private' });

    const sanitizedQuestions = quiz.questions.map(q => {
      const sanitizedQ = {
        _id: q._id, type: q.type, text: q.text, marks: q.marks, originalIndex: q.originalIndex,
        codeLanguage: q.codeLanguage, starterCode: q.starterCode
      };

      if (q.type === 'single' || q.type === 'multiple') {
        let opts = q.options.map(opt => ({ _id: opt._id, text: opt.text }));
        if (quiz.settings?.shuffleOptions) {
          opts = opts.sort(() => Math.random() - 0.5);
        }
        sanitizedQ.options = opts;
      }
      return sanitizedQ;
    });

    const sanitizedQuiz = {
      _id: quiz._id, title: quiz.title, description: quiz.description, timeLimit: quiz.timeLimit,
      passingScore: quiz.passingScore, settings: quiz.settings, antiCheatSettings: quiz.antiCheatSettings,
      instructions: quiz.instructions,
      customFields: quiz.customFields || [],
      isPasswordProtected: !!quiz.password,
      questions: sanitizedQuestions
    };

    res.status(200).json({ success: true, quiz: sanitizedQuiz });
  } catch (error) {
    next(error);
  }
};

module.exports = { createQuiz, getTeacherQuizzes, toggleQuizPublic, deleteQuiz, getPublicQuiz };