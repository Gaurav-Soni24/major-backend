class GeminiKeyManager {
    constructor() {
      // Parse the comma-separated keys from the environment variables
      const keysString = process.env.GEMINI_API_KEYS || "";
      this.keys = keysString.split(',').map(key => key.trim()).filter(key => key.length > 0);
      this.currentIndex = 0;
  
      if (this.keys.length === 0) {
        console.warn("WARNING: No Gemini API keys found in .env (GEMINI_API_KEYS)");
      }
    }
  
    // Returns the current active key
    getCurrentKey() {
      if (this.keys.length === 0) return null;
      return this.keys[this.currentIndex];
    }
  
    // Moves to the next key in the array and returns it
    rotateKey() {
      if (this.keys.length <= 1) {
        console.warn("Cannot rotate Gemini keys: Only one key provided.");
        return this.getCurrentKey(); 
      }
      
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      console.log(`[AI System] Quota exhausted. Rotated to Gemini API Key index: ${this.currentIndex}`);
      return this.getCurrentKey();
    }
  }
  
  // Export a single instance so the state (currentIndex) is shared across the app
  module.exports = new GeminiKeyManager();