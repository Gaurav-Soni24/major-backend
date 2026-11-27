const { GoogleGenerativeAI } = require('@google/generative-ai');
const geminiKeyManager = require('../utils/geminiKeyManager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls Gemini and parses a JSON reply. Retries transient errors with backoff, rotates keys on quota
// errors and falls back to the lite model. Throws a generic Error when everything fails.
const realGenerateJson = async (promptText, { maxTransientRetries = 4 } = {}) => {
  let keyAttempts = 0;
  const maxKeyAttempts = geminiKeyManager.keys.length > 0 ? geminiKeyManager.keys.length : 1;

  while (keyAttempts < maxKeyAttempts) {
    let transientRetries = 0;

    while (transientRetries < maxTransientRetries) {
      try {
        const apiKey = geminiKeyManager.getCurrentKey();
        if (!apiKey) throw new Error('No Gemini API keys configured.');

        const genAI = new GoogleGenerativeAI(apiKey);
        const currentModel = transientRetries >= 2 ? 'gemini-2.5-flash-lite' : 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({
          model: currentModel,
          generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
        });

        const result = await model.generateContent(promptText);
        const responseText = result.response.text();
        // Remove markdown fences some model versions still add.
        const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);
      } catch (error) {
        const errString = (error.message || error.toString() || '').toLowerCase();
        const isTransient =
          errString.includes('503') || errString.includes('500') || errString.includes('high demand') ||
          errString.includes('overloaded') || errString.includes('fetch failed') || errString.includes('parse');
        const isQuota = errString.includes('429') || errString.includes('quota');

        if (isTransient) {
          transientRetries++;
          if (transientRetries >= maxTransientRetries) break;
          await sleep(Math.pow(2, transientRetries) * 1000);
        } else if (isQuota) {
          console.warn('[AI] Key exhausted (429). Rotating...');
          geminiKeyManager.rotateKey();
          keyAttempts++;
          break;
        } else {
          console.error('[AI] Non-retriable error:', errString.slice(0, 200));
          throw error;
        }
      }
    }
    if (transientRetries >= maxTransientRetries) throw new Error('AI service is busy. Please try again.');
  }
  throw new Error('AI quota exhausted. Please try again later.');
};

let impl = realGenerateJson;

const generateJson = (promptText, options) => impl(promptText, options);

// Test hook: replace the Gemini call (pass nothing to restore the real one).
const setAiClient = (fn) => {
  impl = fn || realGenerateJson;
};

module.exports = { generateJson, setAiClient };
