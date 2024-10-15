import express from 'express';
import multer from 'multer'; // To handle file uploads
import OpenAI from 'openai';
import cors from 'cors';
import fs from 'fs';
import dotenv from 'dotenv';
import pdfParse from 'pdf-parse';

dotenv.config();

const app = express();
const port = 3001;

// Set up middleware
app.use(cors());
app.use(express.json());

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Initialize OpenAI API
const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_API
});

// Cache to store multiple files with their context/topic
let fileCache = [];
let activeFile = null; // To track the currently active file for follow-ups
let compareMode = false; // Track if "both files" mode is active

// Function to extract file references (topics) from the question
function extractFileTopics(question) {
  const regex = /compare (the )?file (about|with) (.+?) (and|with) (the )?file (about|with) (.+)/i;
  const match = question.match(regex);
  if (match) {
    return [match[3].toLowerCase(), match[7].toLowerCase()];
  }
  return null;
}

// Function to determine the file context (AI, Blockchain, etc.)
async function determineFileContext(fileContent) {
  const contextRequest = [
    { role: 'system', content: 'You are a helpful assistant who categorizes files based on their content.' },
    { role: 'user', content: `Can you briefly describe the topic of this content: ${fileContent.substring(0, 1000)}` }
  ];

  const completion = await openai.chat.completions.create({
    messages: contextRequest,
    model: 'gpt-4',
  });

  const topic = completion.choices[0].message.content.trim();
  return topic.toLowerCase();  // Return the inferred topic in lowercase for consistency
}

app.post('/upload', upload.single('file'), async (req, res) => {
  const { question } = req.body;
  const file = req.file;
  let fileContent = '';

  try {
    if (file) {
      // If a new file is uploaded
      if (file.mimetype === 'application/pdf') {
        const dataBuffer = fs.readFileSync(file.path);
        const pdfData = await pdfParse(dataBuffer);
        fileContent = pdfData.text;
      } else {
        fileContent = fs.readFileSync(file.path, 'utf8');
      }

      // Determine the context/topic of the file
      const fileContext = await determineFileContext(fileContent);

      // Store each file with its content and context in a list
      fileCache.push({ context: fileContext, content: fileContent });
      activeFile = fileCache[fileCache.length - 1];  // Set the latest file as the active one
    }

    // Handle file comparisons
    const fileTopics = extractFileTopics(question);
    if (fileTopics) {
      const [topic1, topic2] = fileTopics;

      const foundFile1 = fileCache.find(file => file.context.includes(topic1));
      const foundFile2 = fileCache.find(file => file.context.includes(topic2));

      if (foundFile1 && foundFile2) {
        fileContent = `Comparison between files about ${foundFile1.context} and ${foundFile2.context}:\n\nFile 1 (${foundFile1.context}):\n${foundFile1.content}\n\nFile 2 (${foundFile2.context}):\n${foundFile2.content}`;
      } else {
        return res.status(400).json({ error: 'One or both files are not available for comparison.' });
      }
    } else {
      // Check if the user explicitly mentions switching files
      const firstFile = fileCache[0];
      const secondFile = fileCache[1];

      if (question && question.toLowerCase().includes('first file')) {
        activeFile = firstFile;  // Switch to the first file
        compareMode = false; // Exit comparison mode
      } else if (question && question.toLowerCase().includes('second file')) {
        activeFile = secondFile;  // Switch to the second file
        compareMode = false; // Exit comparison mode
      } else if (question && question.toLowerCase().includes('both files')) {
        // Set comparison mode to true when "both files" is mentioned
        compareMode = true;
      }

      // Answer based on the current mode (single file or both files)
      if (compareMode && fileCache.length >= 2) {
        const firstFileContent = fileCache[0].content;
        const secondFileContent = fileCache[1].content;
        fileContent = `Both Files:\n\nFirst File:\n${firstFileContent}\n\nSecond File:\n${secondFileContent}`;
      } else if (activeFile) {
        fileContent = activeFile.content;
      } else if (!file && fileCache.length === 0) {
        // No file uploaded and no files in cache, just respond to the question
        fileContent = `General Question:\n\n${question}`;
      } else {
        // Default to the latest file if no context switch is requested
        const latestFile = fileCache[fileCache.length - 1];
        fileContent = latestFile.content;
      }
    }

    const messages = [
      { role: 'system', content: 'You are a helpful assistant that answers questions based on one or more files or general queries.' },
      { role: 'user', content: `File Content: ${fileContent}` },
      { role: 'user', content: `Question: ${question}` }
    ];

    const completion = await openai.chat.completions.create({
      messages,
      model: 'gpt-4',
    });

    const assistantMessage = completion.choices[0].message.content;

    res.json({ answer: assistantMessage });
  } catch (error) {
    res.status(500).json({ error: 'Error processing the request' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
