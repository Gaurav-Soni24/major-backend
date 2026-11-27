# Quizify: AI-Powered Assessment Platform (Backend API)

REST API for **Quizify**, my B.Tech final-year project at Government Engineering College, Bilaspur. It handles teacher accounts, quiz authoring (with Gemini), proctored student attempts, server-side time limits and grading, and review analytics.

- **Frontend repo:** https://github.com/Gaurav-Soni24/major-frontend
- **Live demo (frontend):** https://major-frontend-sable.vercel.app

## Features

- **Auth:** email/password (bcrypt) and Google sign-in (requires a verified Google email), 8 h teacher JWTs. New accounts are always teachers.
- **Quiz authoring:** create, edit (`PUT`), duplicate, publish/unpublish, delete (cascades to submissions), strict validation of every field, AI generation from a syllabus and single-question regeneration (Gemini with retry, model fallback and key rotation).
- **Five question types:** `single`, `multiple`, `integer`, `text`, `code`. Objective types are graded deterministically on the server (multiple = set equality, integer = numeric compare); `text`/`code` are graded by Gemini with marks clamped to `[0, marks]`.
- **Students have no account.** Google identity -> `studentToken` (2 h) -> per-attempt `attemptToken`. Answers autosave, so a reload resumes the attempt instead of locking the student out.
- **Server is the clock:** each attempt has a `deadlineAt`; autosave after `deadline + grace` is rejected (410), late submits grade only saved answers, and expired attempts are finalized by a 60 s sweeper and on teacher reads.
- **Atomic, idempotent submit:** one grading per attempt even with concurrent requests; repeat calls return the stored result.
- **If AI grading fails** the submission is kept with `needsReview: true` and the teacher grades it by hand (`PATCH .../grade`).
- **Teacher insight:** paginated `my-quizzes` with aggregated stats, `dashboard/summary`, per-quiz `analytics`, submission review with filters, flagged webcam snapshots (details only).
- **Anti-cheat records:** tab switches, webcam strikes, copy/paste, reloads, identity swap, auto-submit, up to 20 flagged snapshots per attempt (400 KB each).

## Tech stack

Node.js (CommonJS), Express 5, MongoDB (Mongoose 9), JWT, bcryptjs, Google Generative AI SDK, google-auth-library, helmet, express-rate-limit, morgan. Tests: `node:test`, supertest, mongodb-memory-server.

## API overview

All paths are under `/api`. Errors are always `{ success:false, code, message, details? }`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/health` (no `/api`) | none | Liveness, does not touch the DB |
| POST | `/auth/register`, `/auth/login`, `/auth/google` | none | Register and sign in |
| GET / PUT | `/auth/profile` | teacher | Read or update the profile (`currentPassword` needed to change an existing password) |
| POST | `/quizzes/create` | teacher | Create a quiz |
| GET | `/quizzes/my-quizzes?page&limit&search&status&sort` | teacher | Paginated list with stats |
| GET / PUT / DELETE | `/quizzes/:quizId` | owner | Read (with answers), edit, delete (+ submissions) |
| POST | `/quizzes/:quizId/duplicate` | owner | Copy as an unpublished draft |
| GET | `/quizzes/:quizId/analytics` | owner | Summary, score distribution, per-question stats |
| POST | `/quizzes/toggle-public` | owner | Publish or unpublish (publishing re-validates) |
| GET | `/quizzes/public/:quizId` | none | Student-safe quiz (no answers, rubrics or password) + `serverTime` |
| GET | `/dashboard/summary` | teacher | Totals, 14-day activity, recent submissions and quizzes |
| POST | `/ai/generate-quiz`, `/ai/regenerate-question` | teacher | AI question generation (10 per 10 min) |
| POST | `/submissions/verify-google` | none | Verify Google identity, returns `studentToken` |
| POST | `/submissions/start-attempt` | student | Start or resume an attempt, returns `attemptToken` |
| PUT | `/submissions/:id/answers` | attempt | Autosave answers and counters |
| POST | `/submissions/flag` | attempt | Record a suspicious-activity snapshot |
| POST | `/submissions` | attempt | Final submit (atomic, idempotent) |
| GET | `/submissions/:id/result` | attempt or student | Result payload (survives refresh) |
| GET | `/submissions/student/:email` | student (same email) | The student's own results |
| GET | `/submissions/quiz/:quizId?page&limit&status&flagged&search&sort` | owner | Submissions + summary |
| GET / DELETE | `/submissions/details/:id` | owner | One submission (with flagged images), or delete it |
| PATCH | `/submissions/details/:id/grade` | owner | Manual grade for one question |

Auth headers: teacher `Authorization: Bearer <jwt>`; student `Authorization: Student <jwt>`; attempt `X-Attempt-Token: <token>`.

## Security notes

- **Ownership:** every teacher route checks that the quiz (or the submission's quiz) belongs to the caller. Missing and not-yours quizzes both return 404.
- **No student accounts, but no anonymous writes:** attempts are tied to a verified Google email (`studentToken`) and protected by an unguessable `attemptToken` (only its SHA-256 is stored, compared in constant time).
- **NoSQL injection:** request bodies must be plain objects, keys starting with `$` or containing `.` are rejected (query strings also reject bracket syntax), and every field is type-checked by the validators.
- **Rate limits** (per IP, in memory): login/register 10 per 15 min, Google 20 per 15 min, start-attempt 30 per 10 min, autosave 120 per min and flag 30 per min per attempt, AI 10 per 10 min per teacher, everything else 300 per 15 min. Set `TRUST_PROXY` correctly behind a proxy or all users share one bucket. Counters are per process: use a shared store if you run several instances.
- **Body limits:** 100 kb default, 1 mb for submit/autosave, 2 mb for flag (image <= 400 KB decoded).
- **Quiz passwords** are bcrypt-hashed; legacy plaintext values are accepted once and re-hashed (or run `npm run migrate`).
- **Errors** never include stack traces or internal messages; unexpected errors are logged server-side and returned as `INTERNAL`.
- **AI grading prompts** treat student text as untrusted data and every awarded mark is clamped to the question's marks.
- **CORS** allow-list from `CORS_ORIGIN`. Helmet is enabled.
- The server refuses to start without `JWT_SECRET` and `MONGO_URI`.

## Run locally

```bash
git clone https://github.com/Gaurav-Soni24/major-backend.git
cd major-backend
npm install
cp .env.example .env   # then fill in the values
npm start
```

The API listens on `http://localhost:5000`. The frontend needs `NEXT_PUBLIC_API_URL` set to the API base **including `/api`**, for example `http://localhost:5000/api`.

## Tests

```bash
npm test
```

Runs `node --test tests/*.test.js` against an in-memory MongoDB (`mongodb-memory-server`, which downloads a MongoDB binary on first run) with test doubles for Google verification and Gemini. No environment variables, accounts or network services are needed. Production code always calls the real Google and Gemini clients.

## Migrating an existing database

```bash
npm run migrate -- --dry   # report only
npm run migrate            # apply
```

Idempotent. It lowercases submission emails, reports duplicate `(quizId, email)` submissions and keeps the most advanced one, back-fills `deadlineAt` for open attempts of timed quizzes, bcrypt-hashes plaintext quiz passwords and builds the new indexes (including the unique `(quizId, email)` index). Take a backup first: it deletes the duplicate submissions it reports.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Secret used to sign teacher JWTs (long random string) |
| `PORT` | no | Server port (default `5000`) |
| `NODE_ENV` | no | `development` or `production` |
| `GOOGLE_CLIENT_ID` | for Google sign-in | Google OAuth client ID |
| `GEMINI_API_KEYS` | for AI features | One or more Gemini API keys, comma-separated (rotated on quota errors) |
| `CORS_ORIGIN` | no | Comma-separated allowed browser origins. Unset: any origin in development, same host in production |
| `STUDENT_TOKEN_SECRET` | no | Secret for student tokens (defaults to `JWT_SECRET`) |
| `ATTEMPT_GRACE_SECONDS` | no | Tolerance after the deadline (default `15`) |
| `TRUST_PROXY` | no | Number of proxies in front of the app (`1` on Render) |

## Related

- Frontend: https://github.com/Gaurav-Soni24/major-frontend
- Portfolio: https://gauravsoni.space
