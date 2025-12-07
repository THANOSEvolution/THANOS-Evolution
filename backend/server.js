/*
 * THANOS Evolution - Complete Backend Server
 * Features: Auth, Patient Registration, Offline Sync, Real-time Updates
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✓ MongoDB connected'))
.catch(err => console.error('✗ MongoDB error:', err));

// ==================== SCHEMAS ====================

const doctorSchema = new mongoose.Schema({
  doctorId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  department: { type: String, required: true },
  hospital: { type: String, required: true },
  phone: String,
  createdAt: { type: Date, default: Date.now }
});

const patientSchema = new mongoose.Schema({
  patientId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  age: { type: Number, required: true },
  gender: String,
  diagnosis: { type: String, required: true },
  affectedSide: String,
  incidentDate: Date,
  admissionDate: { type: Date, required: true },
  doctorId: { type: String, required: true },
  deviceSerial: String,
  phone: String,
  medicalNotes: String,
  emergencyContact: {
    name: String,
    phone: String,
    relationship: String
  },
  createdAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  patientId: { type: String, required: true },
  doctorId: { type: String, required: true },
  startTime: { type: Date, default: Date.now },
  endTime: Date,
  currentExercise: String,
  totalDuration: Number,
  totalPoses: { type: Number, default: 0 },
  totalDataPoints: { type: Number, default: 0 },
  averageHeartRate: Number,
  averageSpO2: Number,
  averageGSR: Number,
  status: { type: String, default: 'active' }
});

const dataPointSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  patientId: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  pose: String,
  servoPositions: {
    thumb: Number,
    index: Number,
    middle: Number,
    ring: Number,
    pinky: Number
  },
  physiological: {
    gsr: Number,
    emg: Number,
    heartRate: Number,
    spo2: Number
  },
  offlineId: String,
  synced: { type: Boolean, default: true }
});

const alertSchema = new mongoose.Schema({
  sessionId: String,
  patientId: { type: String, required: true },
  doctorId: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  severity: { type: String, default: 'medium' },
  type: String,
  message: String,
  value: Number,
  resolved: { type: Boolean, default: false }
});

const Doctor = mongoose.model('Doctor', doctorSchema);
const Patient = mongoose.model('Patient', patientSchema);
const Session = mongoose.model('Session', sessionSchema);
const DataPoint = mongoose.model('DataPoint', dataPointSchema);
const Alert = mongoose.model('Alert', alertSchema);

// ==================== AUTH MIDDLEWARE ====================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, error: 'No token' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ==================== AUTH ROUTES ====================

// Doctor Register
app.post('/api/auth/doctor/register', async (req, res) => {
  try {
    const { email, password, name, department, hospital, phone } = req.body;
    
    const existing = await Doctor.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const doctorId = `DOC-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    
    const doctor = new Doctor({
      doctorId, email, password: hashedPassword, name, department, hospital, phone
    });
    
    await doctor.save();
    const token = jwt.sign({ doctorId, role: 'doctor' }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      success: true,
      token,
      doctor: { doctorId, name, email, department, hospital }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Doctor Login
app.post('/api/auth/doctor/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const doctor = await Doctor.findOne({ email });
    
    if (!doctor) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, doctor.password);
    if (!validPassword) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ doctorId: doctor.doctorId, role: 'doctor' }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({
      success: true,
      token,
      doctor: { doctorId: doctor.doctorId, name: doctor.name, email: doctor.email }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Patient Register (by Doctor)
app.post('/api/auth/patient/register', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'doctor') {
      return res.status(403).json({ success: false, error: 'Only doctors can register patients' });
    }
    
    const { email, password, name, age, gender, diagnosis, affectedSide, incidentDate, admissionDate, deviceSerial, phone, medicalNotes, emergencyContact } = req.body;
    
    const existing = await Patient.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const patientId = `PT-${new Date().getFullYear()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    
    const patient = new Patient({
      patientId, email, password: hashedPassword, name, age, gender, diagnosis,
      affectedSide, incidentDate, admissionDate, doctorId: req.user.doctorId,
      deviceSerial, phone, medicalNotes, emergencyContact
    });
    
    await patient.save();
    
    res.json({
      success: true,
      patient: { patientId, name, email }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Patient Login
app.post('/api/auth/patient/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const patient = await Patient.findOne({ email });
    
    if (!patient) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, patient.password);
    if (!validPassword) {
      return res.status(400).json({ success: false, error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ patientId: patient.patientId, role: 'patient' }, JWT_SECRET, { expiresIn: '7d' });
    const doctor = await Doctor.findOne({ doctorId: patient.doctorId });
    
    res.json({
      success: true,
      token,
      patient: { patientId: patient.patientId, name: patient.name, email: patient.email, doctorName: doctor ? doctor.name : 'Unknown' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== DOCTOR DASHBOARD ====================

// Get all patients
app.get('/api/doctor/patients', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'doctor') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    const patients = await Patient.find({ doctorId: req.user.doctorId }).select('-password');
    
    const enriched = await Promise.all(patients.map(async (patient) => {
      const activeSession = await Session.findOne({ patientId: patient.patientId, status: 'active' });
      const latestData = activeSession ? await DataPoint.findOne({ sessionId: activeSession.sessionId }).sort({ timestamp: -1 }) : null;
      
      return {
        ...patient.toObject(),
        sessionActive: !!activeSession,
        currentSession: activeSession,
        latestVitals: latestData ? latestData.physiological : null
      };
    }));
    
    res.json({ success: true, patients: enriched });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get doctor stats
app.get('/api/doctor/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'doctor') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    
    const totalPatients = await Patient.countDocuments({ doctorId: req.user.doctorId });
    const activeSessions = await Session.countDocuments({ doctorId: req.user.doctorId, status: 'active' });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaySessions = await Session.countDocuments({ doctorId: req.user.doctorId, startTime: { $gte: today } });
    const activeAlerts = await Alert.countDocuments({ doctorId: req.user.doctorId, resolved: false });
    
    res.json({ success: true, stats: { totalPatients, activeSessions, todaySessions, activeAlerts } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== SESSION MANAGEMENT ====================

// Start session
app.post('/api/session/start', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'patient') {
      return res.status(403).json({ success: false, error: 'Only patients can start sessions' });
    }
    
    const patient = await Patient.findOne({ patientId: req.user.patientId });
    const sessionId = `SESSION-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    
    const session = new Session({
      sessionId,
      patientId: patient.patientId,
      doctorId: patient.doctorId,
      deviceSerial: patient.deviceSerial
    });
    
    await session.save();
    
    io.to(`doctor-${patient.doctorId}`).emit('session-started', {
      patientId: patient.patientId,
      patientName: patient.name,
      sessionId
    });
    
    res.json({ success: true, session: { sessionId, startTime: session.startTime } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// End session
app.post('/api/session/end', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await Session.findOne({ sessionId });
    
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    const dataPoints = await DataPoint.find({ sessionId });
    
    const avgHeartRate = dataPoints.reduce((sum, dp) => sum + (dp.physiological.heartRate || 0), 0) / (dataPoints.length || 1);
    const avgSpO2 = dataPoints.reduce((sum, dp) => sum + (dp.physiological.spo2 || 0), 0) / (dataPoints.length || 1);
    const avgGSR = dataPoints.reduce((sum, dp) => sum + (dp.physiological.gsr || 0), 0) / (dataPoints.length || 1);
    
    session.endTime = new Date();
    session.totalDuration = Math.floor((session.endTime - session.startTime) / 1000);
    session.totalDataPoints = dataPoints.length;
    session.averageHeartRate = Math.round(avgHeartRate);
    session.averageSpO2 = Math.round(avgSpO2);
    session.averageGSR = Math.round(avgGSR);
    session.status = 'completed';
    
    await session.save();
    
    io.to(`doctor-${session.doctorId}`).emit('session-ended', {
      patientId: session.patientId,
      sessionId,
      duration: session.totalDuration
    });
    
    res.json({ success: true, session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== DATA STREAMING ====================

// Stream data
app.post('/api/data/stream', authenticateToken, async (req, res) => {
  try {
    const { session_id, pose, servo_positions, gsr, emg, heart_rate, spo2, session_duration } = req.body;
    
    const session = await Session.findOne({ sessionId: session_id });
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    session.currentExercise = pose;
    await session.save();
    
    const dataPoint = new DataPoint({
      sessionId: session_id,
      patientId: session.patientId,
      pose,
      servoPositions: {
        thumb: servo_positions[0],
        index: servo_positions[1],
        middle: servo_positions[2],
        ring: servo_positions[3],
        pinky: servo_positions[4]
      },
      physiological: { gsr, emg, heartRate: heart_rate, spo2 },
      sessionDuration: session_duration
    });
    
    await dataPoint.save();
    
    // Check alerts
    if (heart_rate > 100) {
      const alert = new Alert({
        sessionId: session_id,
        patientId: session.patientId,
        doctorId: session.doctorId,
        severity: heart_rate > 120 ? 'critical' : 'high',
        type: 'heart_rate',
        message: `Elevated heart rate: ${heart_rate} bpm`,
        value: heart_rate
      });
      await alert.save();
      io.to(`doctor-${session.doctorId}`).emit('alert', alert);
    }
    
    io.to(`doctor-${session.doctorId}`).emit('patient-data', {
      patientId: session.patientId,
      sessionId: session_id,
      data: dataPoint
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== OFFLINE SYNC ====================

// Upload offline data
app.post('/api/sync/upload', authenticateToken, async (req, res) => {
  try {
    const { offlineData } = req.body;
    const synced = [];
    const failed = [];
    
    for (const data of offlineData) {
      try {
        const existing = await DataPoint.findOne({ offlineId: data.offlineId });
        
        if (!existing) {
          const dataPoint = new DataPoint({
            ...data,
            syncedAt: new Date(),
            synced: true
          });
          await dataPoint.save();
          synced.push(data.offlineId);
        } else {
          synced.push(data.offlineId);
        }
      } catch (error) {
        failed.push({ id: data.offlineId, error: error.message });
      }
    }
    
    res.json({ success: true, synced: synced.length, failed: failed.length, failedItems: failed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== WEBSOCKET ====================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join', (data) => {
    const { role, id } = data;
    if (role === 'doctor') {
      socket.join(`doctor-${id}`);
      console.log(`Doctor ${id} joined`);
    } else if (role === 'patient') {
      socket.join(`patient-${id}`);
      console.log(`Patient ${id} joined`);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ==================== START SERVER ====================

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  THANOS Evolution - Backend Server                   ║
║  Server running on port ${PORT}                      ║
║  MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected ✓' : 'Disconnected ✗'}                              ║
╚═══════════════════════════════════════════════════════╝
  `);
});
