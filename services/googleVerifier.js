const { OAuth2Client } = require('google-auth-library');

// Production implementation: verifies a Google ID token against GOOGLE_CLIENT_ID.
let client = null;
const realVerify = async (credential) => {
  if (!client) client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  return ticket.getPayload();
};

let impl = realVerify;

// Returns the Google payload ({ email, email_verified, name, sub, picture }). Throws if invalid.
const verifyGoogleCredential = (credential) => impl(credential);

// Test hook: replace the implementation (pass nothing to restore the real one).
const setGoogleVerifier = (fn) => {
  impl = fn || realVerify;
};

module.exports = { verifyGoogleCredential, setGoogleVerifier };
