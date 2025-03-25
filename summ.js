
const express = require("express");
const http = require('http');
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { spawn } = require("child_process");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

require("dotenv").config();

const app = express();
const server = http.createServer(app); 

const port = 5050;

// Middleware
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
      cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
      cb(null, `audio-${Date.now()}${path.extname(file.originalname)}`);
  }
});

// MongoDB connection
mongoose.connect("mongodb://127.0.0.1:27017/SmartSummary", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const db = mongoose.connection;

db.once("open", () => {
  console.log("✅ MongoDB Connected Successfully");
});

// Define Schemas and Models
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const User = mongoose.model("User", UserSchema);

const NoteSchema = new mongoose.Schema({
  email: String,
  title: String,
  content: String,
  summary: String,
  markdown: String,
  duration: String,
  score: { type: Number, default: 80 },
  createdAt: { type: Date, default: Date.now }
});
const Note = mongoose.model("Note", NoteSchema);

// Check JWT_SECRET
if (!process.env.JWT_SECRET) {
  throw new Error("🚨 JWT_SECRET is not defined in environment variables!");
}
console.log("🔐 JWT Secret Key Loaded Successfully!");

const upload = multer({ 
  storage: storage,
  limits: { 
      fileSize: 50 * 1024 * 1024 // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
      // Accept audio files only
      const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/x-wav'];
      if (allowedTypes.includes(file.mimetype)) {
          cb(null, true);
      } else {
          cb(new Error('Invalid file type. Only audio files are allowed.'));
      }
  }
});

// ✅ Registration API
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).send("❌ User already exists!");

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ email, password: hashedPassword });
    await newUser.save();

    const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.status(201).send({ message: "✅ User registered successfully!", token });
  } catch (error) {
    console.error("❌ Registration Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ Login API
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ err: "❌ User not found!" });

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) return res.status(400).json({ err: "❌ Invalid password!" });

    const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.json({ message: "✅ Login successful!", token });
  } catch (error) {
    console.error("❌ Login Error:", error);
    res.status(500).json({ err: "Internal Server Error" });
  }
});

// ✅ Upload and Transcription API
app.post("/upload", upload.single("audio"), (req, res) => {
  // Validate file
  if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
  }

  const filePath = req.file.path;
  console.log("Processing file:", filePath);

  // Changed from python3 to python for Windows compatibility
  const pythonProcess = spawn("python", ["transcript.py", filePath]);

  let transcriptionResult = "";
  let errorOutput = "";

  // Collect output
  pythonProcess.stdout.on("data", (data) => {
      transcriptionResult += data.toString();
  });

  // Collect errors
  pythonProcess.stderr.on("data", (data) => {
      errorOutput += data.toString();
      console.error("Transcription Error:", data.toString());
  });

  // Handle process completion
  pythonProcess.on("close", (code) => {
      // Always attempt to delete the file
      fs.unlink(filePath, (err) => { 
          if (err) console.error("Error deleting file:", err); 
      });

      // Handle transcription result
      if (code !== 0) {
          return res.status(500).json({ 
              error: "Transcription failed", 
              details: errorOutput 
          });
      }

      // Send successful response
      res.json({ 
          transcription: transcriptionResult.trim(),
          success: true
      });
  });
});

// Create email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: "smtp.gmail.com", 
  port: 587, 
  secure: false,
  auth: {
    user: process.env.USER, 
    pass: process.env.APP_PASSWORD,
  },
});

// Updated summarize endpoint using Hugging Face directly
app.post("/summarize", async (req, res) => {
  const { text, title, email, duration } = req.body;

  if (!text) {
    return res.status(400).json({ error: "No text provided" });
  }

  try {
    // Use Python for summarization
    const pythonProcess = spawn("python", ["summarize.py", text]);
    let summary = "";
    let errorOutput = "";

    pythonProcess.stdout.on("data", (data) => {
        summary += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
        errorOutput += data.toString();
        console.error(`Summarization Error: ${data}`);
    });

    pythonProcess.on("close", async (code) => {
      if (code !== 0) {
          return res.status(500).json({ 
              error: "Error processing summary", 
              details: errorOutput 
          });
      }

      try {
        // Store in MongoDB
        const newNote = new Note({
          email: email || "anonymous@example.com",
          title: title || "Untitled Meeting",
          content: text,
          summary: summary.trim(), // Just trim the direct summary string
          markdown: summary.trim(), // Use the trimmed summary
          duration: duration || "N/A",
          score: Math.floor(Math.random() * 21) + 80
        });
          
        await newNote.save();
          
        // Send email notification
        const mailOptions = {
          from: process.env.USER,
          to: "shrivastava.ananya2003@gmail.com", // Use provided email or default
          subject: "Meeting Notes",
          text: "Your meeting notes are ready",
          html: `
            <b>
              <h1>👋 Welcome to Smart Summary</h1>
              <h2>Thanks for using SmartSummary. &#x2728;</h2>
              <p>Your meeting notes are ready. Please head over to your Dashboard at: <a href="http://localhost:5000/dashboard">Dashboard</a> to view your notes.</p>
              
              <p style="text-align: center;">
                <img src="cid:mail-gif" alt="You Got Mail" style="width: 450px; height: auto;">
              </p>
               <p>Happy Meetings!</p>
            </b>
          `,
          attachments: [{
            filename: 'you-got-mail-email.gif',
            path: 'C:/Users/91942/Desktop/Smart/BackEnd/you-got-mail-email.gif',
            cid: 'mail-gif',
            contentDisposition: 'inline'
          }]
        };

        // Send email function
        const sendMail = async (transporter, mailOptions) => {
          try {
            await transporter.sendMail(mailOptions);
            console.log(`email has been sent`);
          }
          catch(error){
            console.error("Error sending email:", error);
          }
        }         
          
        // Send the email
        console.log("Attempting to send email...");            
        await sendMail(transporter, mailOptions);

        console.log("Email sending process completed.");
          
        // Return success response
        res.json({ 
          success: true, 
          summary: summary.trim(),
          message: "Summary generated and saved successfully" 
        });
          
      } catch (dbError) {
        console.error("Database Error:", dbError);
        res.status(500).json({ 
          error: "Failed to save summary to database", 
          details: dbError.message 
        });
      }
    }); 
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ 
      error: "Something went wrong", 
      details: error.message 
    });
  }
});

// Endpoint to get all notes (without authentication check for now)
app.get("/notes", async (req, res) => {
  try {
    // Get all notes from the database
    // You can add filtering by email later when you implement auth
    const notes = await Note.find({}).sort({ createdAt: -1 });
    res.json(notes);
  } catch (error) {
    console.error("Error fetching notes:", error);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Endpoint to get a single note by ID
app.get("/notes/:id", async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ error: "Note not found" });
    }
    res.json(note);
  } catch (error) {
    console.error("Error fetching note:", error);
    res.status(500).json({ error: "Failed to fetch note" });
  }
});

// Endpoint to update a note
app.post("/notes/update", async (req, res) => {
  try {
    const { id, title, markdown } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: "Note ID is required" });
    }

    const updatedNote = await Note.findByIdAndUpdate(
      id,
      { 
        title: title,
        markdown: markdown 
      },
      { new: true } // Return the updated document
    );

    if (!updatedNote) {
      return res.status(404).json({ error: "Note not found" });
    }

    res.json(updatedNote);
  } catch (error) {
    console.error("Error updating note:", error);
    res.status(500).json({ error: "Failed to update note" });
  }
});

// Endpoint to delete a note
app.post("/notes/delete", async (req, res) => {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: "Note ID is required" });
    }

    const deletedNote = await Note.findByIdAndDelete(id);
    
    if (!deletedNote) {
      return res.status(404).json({ error: "Note not found" });
    }

    res.json({ message: "Note deleted successfully" });
  } catch (error) {
    console.error("Error deleting note:", error);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// Global error handler
app.use((err, req, res, next) => { 
  console.error(err.stack);
  res.status(500).json({ 
      error: "Something went wrong!", 
      details: err.message 
  });
});

// Start server
const PORT = process.env.PORT || 5050;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;

