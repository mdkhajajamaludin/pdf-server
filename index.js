const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfjsLib = require('pdfjs-dist');
require('dotenv').config();

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.js');

// Initialize express app and other middleware
const app = express();
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://namtech-pdf.netlify.app',  // Add your Netlify domain
    'https://pdf-server-gin9.onrender.com/'  // Add your Render domain
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// Database connection configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true
  },
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

// Test database connection and create table
const initializeDatabase = async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('Database connected successfully');
    
    // Check if table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'pdfs'
      );
    `);

    if (!tableExists.rows[0].exists) {
      // Create table if it doesn't exist
      await client.query(`
        CREATE TABLE pdfs (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          file_name VARCHAR(255) NOT NULL,
          file_path VARCHAR(255) NOT NULL,
          content TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('Table created successfully');
    } else {
      // Alter table to add content column if it doesn't exist
      await client.query(`
        DO $$ 
        BEGIN 
          IF NOT EXISTS (
            SELECT FROM information_schema.columns 
            WHERE table_name = 'pdfs' AND column_name = 'content'
          ) THEN 
            ALTER TABLE pdfs ADD COLUMN content TEXT;
          END IF;
        END $$;
      `);
      console.log('Table schema updated successfully');
    }
  } catch (err) {
    console.error('Database initialization error:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
  }
};

// Initialize database on startup
initializeDatabase();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, './uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'pdf-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // Increased to 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
});

// Routes
// Get PDFs for a user
app.get('/api/pdfs/:userId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.params;
    const result = await client.query(
      'SELECT * FROM pdfs WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch PDFs: ' + error.message
    });
  } finally {
    client.release();
  }
});

// PDF extraction function
const extractTextFromPDF = async (filePath) => {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = new Uint8Array(dataBuffer);
    
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    let fullText = '';

    for (let i = 1; i <= numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }

    return fullText.trim();
  } catch (error) {
    console.error('PDF extraction error:', error);
    throw new Error('Failed to extract text from PDF: ' + error.message);
  }
};

// Update the upload endpoint with better logging
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    console.log('Upload request received:', req.body);
    console.log('File details:', req.file);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    if (!req.body.userId) {
      return res.status(400).json({
        success: false,
        error: 'No user ID provided'
      });
    }

    // Extract text from PDF using PDF.js
    console.log('Starting text extraction from:', req.file.path);
    const pdfText = await extractTextFromPDF(req.file.path);
    console.log('Extracted text length:', pdfText.length);
    console.log('First 100 characters of extracted text:', pdfText.substring(0, 100));

    if (!pdfText || pdfText.length === 0) {
      throw new Error('No text could be extracted from the PDF');
    }

    // Log the query parameters
    console.log('Inserting into database with params:', {
      userId: req.body.userId,
      fileName: req.file.originalname,
      filePath: req.file.filename,
      contentLength: pdfText.length
    });

    const result = await client.query(
      'INSERT INTO pdfs (user_id, file_name, file_path, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.body.userId, req.file.originalname, req.file.filename, pdfText]
    );

    console.log('Database insert successful, returned row:', result.rows[0]);

    return res.status(200).json({
      success: true,
      file: result.rows[0]
    });
  } catch (error) {
    console.error('Upload error:', error);
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process PDF'
    });
  } finally {
    if (client) client.release();
  }
});

// Update chat endpoint
app.post('/api/chat', async (req, res) => {
  let client;
  try {
    const { pdfId, question, userId, sourceOnly = true } = req.body;
    console.log('Chat request received:', { pdfId, userId, question });
    
    client = await pool.connect();
    
    // First, verify the PDF exists
    const pdfExists = await client.query(
      'SELECT id, file_name FROM pdfs WHERE id = $1 AND user_id = $2',
      [pdfId, userId]
    );

    if (pdfExists.rows.length === 0) {
      console.log('PDF not found:', { pdfId, userId });
      return res.status(404).json({ error: 'PDF not found' });
    }

    // Then get the content
    const pdfResult = await client.query(
      'SELECT content FROM pdfs WHERE id = $1',
      [pdfId]
    );

    console.log('PDF query result rows:', pdfResult.rows.length);
    console.log('Content exists:', !!pdfResult.rows[0]?.content);
    
    if (!pdfResult.rows[0]?.content) {
      console.log('PDF content is empty for ID:', pdfId);
      return res.status(400).json({ error: 'PDF content is empty' });
    }

    const pdfContent = pdfResult.rows[0].content;
    console.log('Content length:', pdfContent.length);

    // Reduce content length to stay within Gemini's limits
    // Using a reasonable limit for Gemini API
    const MAX_CONTENT_LENGTH = 25000; // Increased slightly to include more context
    const truncatedContent = pdfContent.slice(0, MAX_CONTENT_LENGTH);
    
    // Enhanced prompt to strictly answer only from PDF content
    const prompt = `You are a PDF document assistant. Answer STRICTLY with information directly from the provided document content.

    CRITICAL INSTRUCTIONS:
    1. ONLY use information that is explicitly stated in the document content.
    2. If the answer is not in the document, respond ONLY with "I don't find information about that in the document."
    3. DO NOT include ANY information from outside the document.
    4. DO NOT include phrases like "According to the document", "Based on the document", or similar prefixes.
    5. DO NOT include ANY disclaimers, introductions, or explanations.
    6. Just provide the direct factual answer found in the document.
    7. DO NOT make up or infer information not explicitly stated.
    8. Keep answers concise and direct.
    9. Format your answer clearly matching the style of the document when appropriate.
    10. For mathematical content, preserve equations exactly as they appear.
    
    Question: "${question}"
    
    Document content: ${truncatedContent}`;

    // Log prompt length for debugging
    console.log('Prompt length:', prompt.length);

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let answer = response.text() || '';
    
    // Further clean up the response to remove any meta-commentary
    answer = answer
      .replace(/^(according to the (document|pdf|text|content)|the (document|pdf|text) (states|mentions|says|indicates|shows|provides|contains|notes)|based on the (document|pdf|text|content)|from the (document|pdf|text)|in the (document|pdf|text))/gi, '')
      .replace(/^(i can see that|i found that|i notice that|i observe that|i found in the document)/gi, '')
      .replace(/^(to answer your question|regarding your question|in response to your question)/gi, '')
      .replace(/^(here is|here's|the answer is|the information is)/gi, '')
      .trim()
      .replace(/^[:.,-\s]+/, '')
      .trim();
      
    res.json({ answer });
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (client) client.release();
  }
});

// Update the delete endpoint
app.delete('/api/pdfs/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { userId } = req.query;

    console.log('Delete request received for PDF:', { id, userId });

    if (!id || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    client = await pool.connect();

    // Check if PDF exists and belongs to user
    const checkResult = await client.query(
      'SELECT * FROM pdfs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'PDF not found or unauthorized'
      });
    }

    // Delete from database
    await client.query(
      'DELETE FROM pdfs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    // Try to delete file if it exists
    const filePath = path.join(__dirname, 'uploads', checkResult.rows[0].file_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    return res.status(200).json({
      success: true,
      message: 'PDF deleted successfully'
    });

  } catch (error) {
    console.error('Delete error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: err.message || 'Something went wrong!'
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Database URL:', process.env.DATABASE_URL?.split('@')[1]); // Log database host without credentials
});
