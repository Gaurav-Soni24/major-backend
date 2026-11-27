const mongoose = require('mongoose');

// Connects and returns the connection. Throws on failure: the caller (server.js) decides
// whether to exit, so importing this module never kills a test process.
const connectDB = async (uri = process.env.MONGO_URI) => {
  if (!uri) throw new Error('MONGO_URI is not set');
  const conn = await mongoose.connect(uri);
  console.log(`MongoDB Connected: ${conn.connection.host}`);
  return conn;
};

module.exports = connectDB;
