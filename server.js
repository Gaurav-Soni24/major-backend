require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');

// Connect to MongoDB
connectDB();

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================
// Helmet helps secure Express apps by setting various HTTP headers
app.use(helmet());

// Enable Cross-Origin Resource Sharing
app.use(cors());

// INCREASED LIMIT: 50mb is required to safely handle multiple base64 webcam captures 
// and large subjective text/code submissions from the frontend.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// HTTP request logger middleware
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

const authRoutes = require('./routes/authRoutes');
const quizRoutes = require('./routes/quizRoutes');
const submitRoutes = require('./routes/submitRoutes');
const aiRoutes = require('./routes/aiRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/submissions', submitRoutes);
app.use('/api/ai', aiRoutes);

// Base test route
app.get('/', (req, res) => {
    res.send('Quizify API Server is running...');
});

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================
app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        success: false,
        message: err.message || 'Server Error',
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});