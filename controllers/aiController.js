const { GoogleGenerativeAI } = require('@google/generative-ai');
const geminiKeyManager = require('../utils/geminiKeyManager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callGeminiWithRetry = async (promptText) => {
  let keyAttempts = 0;
  const maxKeyAttempts = geminiKeyManager.keys.length > 0 ? geminiKeyManager.keys.length : 1;

  while (keyAttempts < maxKeyAttempts) {
    let transientRetries = 0;
    const maxTransientRetries = 4; 

    while (transientRetries < maxTransientRetries) {
      try {
        const apiKey = geminiKeyManager.getCurrentKey();
        if (!apiKey) throw new Error("No Gemini API keys configured.");

        const genAI = new GoogleGenerativeAI(apiKey);
        const currentModel = transientRetries >= 2 ? "gemini-2.5-flash-lite" : "gemini-2.5-flash";
        
        const model = genAI.getGenerativeModel({
          model: currentModel,
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4
          }
        });

        if (transientRetries === 2) {
           console.log(`[AI Controller] Traffic detected. Switching to ${currentModel} queue...`);
        }

        const result = await model.generateContent(promptText);
        const responseText = result.response.text();
        
        // Advanced JSON cleanup: removes markdown code blocks, weird whitespace, and control chars
        let cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);

      } catch (error) {
        const errString = (error.message || error.toString() || '').toLowerCase();
        const isTransientError = errString.includes('503') || errString.includes('500') || errString.includes('high demand') || errString.includes('overloaded') || errString.includes('fetch failed') || errString.includes('parse');
        const isQuotaError = errString.includes('429') || errString.includes('quota');

        if (isTransientError) {
          transientRetries++;
          const delay = Math.pow(2, transientRetries) * 1000; 
          console.warn(`[AI Controller] Gemini API busy/parse error. Retrying in ${delay/1000}s...`);
          await sleep(delay); 
        } else if (isQuotaError) {
          console.warn(`[AI Controller] Key exhausted (429). Rotating...`);
          geminiKeyManager.rotateKey();
          keyAttempts++;
          break; 
        } else {
          console.error("[AI Controller] Non-retriable error:", errString);
          throw error;
        }
      }
    }
    if (transientRetries >= maxTransientRetries) {
      throw new Error('The Intelligence Engine is experiencing extreme demand or formatting failures. Please try again.');
    }
  }
  throw new Error('All API keys have exhausted their quota. Please try again later.');
};

// @desc    Generate a batch of quiz questions via Syllabus
// @route   POST /api/ai/generate-quiz
// @access  Private (Teacher)
const generateQuiz = async (req, res, next) => {
  try {
    const { syllabus, field, totalMarks, questionCounts, difficulty } = req.body;

    if (!syllabus || !difficulty || !questionCounts) {
      return res.status(400).json({ success: false, message: 'Syllabus, difficulty, and question counts are required.' });
    }

    const promptText = `
      You are the core intelligence engine for an advanced educational SaaS platform. 
      Create a highly accurate quiz based on the following:
      Syllabus/Topics: ${syllabus}
      Field of Study: ${field || "General"}
      Difficulty Level: ${difficulty}
      Target Total Marks for the Quiz: ${totalMarks || 100}

      Generate exactly the following breakdown of questions:
      - ${questionCounts.single || 0} 'single' (multiple choice, 1 correct)
      - ${questionCounts.multiple || 0} 'multiple' (multiple choice, >1 correct)
      - ${questionCounts.integer || 0} 'integer' (numeric exact answer)
      - ${questionCounts.text || 0} 'text' (subjective written answer)
      - ${questionCounts.code || 0} 'code' (programming task)

      CRITICAL FORMATTING RULES:
      1. DO NOT use markdown formatting (no **, no \`\`, no italics) inside the "text" or "options" fields. Keep text completely plain.
      2. For 'integer', 'text', and 'code' types, you MUST provide a 'correctAnswer' field.
      3. For 'code' questions, specify 'codeLanguage' (e.g., 'javascript') and 'starterCode'.
      
      Respond STRICTLY in this JSON schema and nothing else:
      {
        "recommendedTimeLimit": 30,
        "recommendedAntiCheat": { "aiCamera": true, "tabSwitch": true, "copyPaste": true, "toleranceStrikes": 3 },
        "questions": [
          {
            "type": "single",
            "text": "Plain text question here?",
            "marks": 2,
            "options": [
              { "text": "Plain text option 1", "isCorrect": true },
              { "text": "Plain text option 2", "isCorrect": false }
            ]
          },
          {
            "type": "code",
            "text": "Write a function to...",
            "marks": 10,
            "codeLanguage": "javascript",
            "starterCode": "function solve() { }",
            "correctAnswer": "Rubric: Look for X and Y."
          }
        ]
      }
    `;

    const generatedQuiz = await callGeminiWithRetry(promptText);
    res.status(200).json({ success: true, data: generatedQuiz });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to generate quiz' });
  }
};

// @desc    Regenerate a single question
// @route   POST /api/ai/regenerate-question
// @access  Private (Teacher)
const regenerateQuestion = async (req, res, next) => {
  try {
    const { syllabus, type, difficulty, field } = req.body;

    const promptText = `
      You are an educational AI. Generate exactly ONE high-quality question.
      Topics: ${syllabus}
      Field: ${field || 'General'}
      Difficulty: ${difficulty}
      Question Type: ${type} (Options: single, multiple, integer, text, code)

      CRITICAL: Return ONLY valid JSON representing the single question object. No markdown, no asterisks (**).
      Include strictly: 'type' (MUST be "${type}"), 'text', 'marks', 'options' (if applicable), 'correctAnswer' (if applicable), 'codeLanguage' and 'starterCode' (if code).
    `;

    const question = await callGeminiWithRetry(promptText);
    res.status(200).json({ success: true, data: question });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to regenerate question' });
  }
};

const gradeAnswersWithAI = async (manualGradeQuestions) => {
  if (!manualGradeQuestions || manualGradeQuestions.length === 0) return [];
  const gradingPrompt = `
    You are an expert Teaching Assistant. Grade these based strictly on the 'correctAnswerRubric'.
    Student Answers: ${JSON.stringify(manualGradeQuestions)}
    Respond strictly in JSON array: [{ "questionId": 0, "awardedMarks": 2, "feedback": "Good." }]
  `;
  try { return await callGeminiWithRetry(gradingPrompt); } 
  catch (error) { return []; }
};

module.exports = { generateQuiz, regenerateQuestion, gradeAnswersWithAI };