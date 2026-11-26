# Quizify — AI-Powered Assessment Platform (Backend API)

REST API for **Quizify**, my B.Tech final-year project at Government Engineering College, Bilaspur. It handles authentication, quiz management, AI question generation with Google Gemini, submissions, grading and anti-cheat records.

- **Frontend repo:** https://github.com/Gaurav-Soni24/major-frontend
- **Live demo (frontend):** https://major-frontend-seven.vercel.app

## Features

- **Auth:** email/password registration and login with hashed passwords (bcrypt) and JWT sessions, plus Google sign-in.
- **AI quiz generation:** generate a quiz from a syllabus, difficulty and per-type question counts, and regenerate a single question, using **Google Gemini** (`gemini-2.5-flash`, falling back to `gemini-2.5-flash-lite`).
- **Resilient AI calls:** retry with exponential backoff on busy or malformed responses, and **rotation across multiple API keys** when a quota is hit.
- **Five question types:** `single`, `multiple`, `text`, `integer` and `code`, with an AI grading rubric for subjective answers.
- **Quiz settings:** time limit, passing score, shuffle questions and options, password protection, public/private sharing and custom registration fields.
- **Anti-cheat records per submission:** tab switches, webcam strikes, copy-paste attempts, identity-swap detection, auto-submit flag and flagged snapshots (stored as base64 images).
- **Security basics:** `helmet`, CORS, JWT-protected teacher routes, request-size limits sized for webcam captures.

## Tech stack

Node.js, Express, MongoDB (Mongoose), JWT, bcryptjs, Google Generative AI SDK, google-auth-library, helmet, morgan.

## API overview

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/login`, `/google` | Register and sign in |
| GET / PUT | `/api/auth/profile` | Read or update the teacher profile |
| POST | `/api/quizzes/create` | Create a quiz |
| GET | `/api/quizzes/my-quizzes` | List a teacher's quizzes |
| GET | `/api/quizzes/public/:quizId` | Public quiz details for students |
| POST | `/api/quizzes/toggle-public` | Publish or unpublish a quiz |
| DELETE | `/api/quizzes/:quizId` | Delete a quiz |
| POST | `/api/ai/generate-quiz`, `/regenerate-question` | AI question generation |
| POST | `/api/submissions/verify-google`, `/start-attempt` | Start a student attempt |
| POST | `/api/submissions/flag` | Record a suspicious activity snapshot |
| POST | `/api/submissions` | Submit answers |
| GET | `/api/submissions/quiz/:quizId`, `/details/:submissionId`, `/student/:email` | Results |

## Run locally

```bash
git clone https://github.com/Gaurav-Soni24/major-backend.git
cd major-backend
npm install
cp .env.example .env   # then fill in the values
npm start
```

The API listens on `http://localhost:5000`. The frontend repo needs `NEXT_PUBLIC_API_URL` to point at it.

### Environment variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default `5000`) |
| `NODE_ENV` | `development` or `production` |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret used to sign JWTs |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GEMINI_API_KEYS` | One or more Gemini API keys, comma-separated (rotated on quota errors) |

## Related

- Frontend: https://github.com/Gaurav-Soni24/major-frontend
- Portfolio: https://gauravsoni.space
