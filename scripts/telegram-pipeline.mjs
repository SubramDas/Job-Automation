#!/usr/bin/env node

/**
 * scripts/telegram-pipeline.mjs
 *
 * Runs the career-ops pipeline headlessly (e.g. from GitHub Actions):
 * 1. Takes JD text or URL from environment (JD_INPUT).
 * 2. Reads cv.md and config/profile.yml as the candidate source of truth.
 * 3. Uses Gemini API to evaluate match, draft form answers, and tailor the CV payload.
 * 4. Renders the HTML CV via build-cv-html.mjs.
 * 5. Compiles the PDF CV via generate-pdf.mjs (Playwright).
 * 6. Sends the analysis, application answers, and resume.pdf to Telegram.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const JD_INPUT = (process.env.JD_INPUT || '').trim();

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  await sendTelegramMessage('❌ Error: GEMINI_API_KEY secret is not set in GitHub repository.');
  process.exit(1);
}

if (!JD_INPUT) {
  await sendTelegramMessage('⚠️ No Job Description or URL was provided.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Telegram Helpers
// ---------------------------------------------------------------------------
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  // Telegram has a 4096 character limit per message
  const chunkSize = 4000;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      // Fallback without HTML formatting if tag parsing fails
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: chunk,
          disable_web_page_preview: true,
        }),
      });
    }
  }
}

async function sendTelegramDocument(filePath, caption = '') {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const fileBuffer = readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  
  const formData = new FormData();
  formData.append('chat_id', CHAT_ID);
  formData.append('document', blob, 'resume.pdf');
  if (caption) {
    formData.append('caption', caption);
  }

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to send document to Telegram: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Extraction Helper
// ---------------------------------------------------------------------------
async function resolveJdText(input) {
  if (/^https?:\/\//i.test(input)) {
    try {
      console.log(`Fetching JD from URL: ${input}`);
      const res = await fetch(input, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const html = await res.text();
      // Strip script/style tags and clean HTML tags
      const cleaned = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `Posting URL: ${input}\n\nContent:\n${cleaned.slice(0, 15000)}`;
    } catch (e) {
      console.warn(`URL fetch failed: ${e.message}, using raw input.`);
      return input;
    }
  }
  return input;
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------
async function main() {
  try {
    const jdText = await resolveJdText(JD_INPUT);

    // Read candidate profile ground truth
    const cvPath = join(ROOT, 'cv.md');
    const profilePath = join(ROOT, 'config/profile.yml');

    const cvContent = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
    const profileContent = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';

    if (!cvContent) {
      throw new Error('cv.md not found in repository.');
    }

    console.log('Connecting to Gemini API...');
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    const prompt = `You are an expert career agent. You will evaluate a Job Description (JD) against the candidate's verified profile and resume.

CANDIDATE cv.md (GROUND TRUTH - NEVER FABRICATE ANY FACT, ROLE, METRIC OR DEGREE NOT LISTED HERE):
${cvContent}

CANDIDATE PROFILE CONFIG:
${profileContent}

JOB DESCRIPTION TO EVALUATE:
${jdText}

INSTRUCTIONS:
1. Identify the company and job title.
2. Evaluate candidate fit on a 1.0 to 5.0 score scale.
3. List 2-3 key strengths and any skill gaps.
4. Draft high-quality answers for standard application form questions:
   - "Why are you interested in this role?"
   - "Why do you want to work at this company?"
   - "Describe a relevant project or achievement from your experience."
5. Generate a tailored CV JSON payload strictly matching the following schema.
   IMPORTANT RULES:
   - Do NOT invent companies, job titles, degrees, or metrics.
   - Emphasize and reorder the candidate's existing experience and projects from cv.md that best match the JD requirements.
   - Candidate object must contain: name, email, phone, location, linkedin, github.

JSON OUTPUT STRUCTURE:
{
  "company": "Company Name",
  "role": "Job Title",
  "score": "4.5 / 5.0",
  "fit_summary": "Concise 2-3 sentence overview of why this candidate fits.",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "gaps": ["Gap 1"],
  "form_answers": {
    "why_role": "Drafted answer...",
    "why_company": "Drafted answer...",
    "relevant_project": "Drafted answer..."
  },
  "cv_payload": {
    "candidate": {
      "name": "Subram Das",
      "email": "subram.iitb@gmail.com",
      "phone": "+91-9365041445",
      "location": "Pune, India",
      "linkedin": "https://linkedin.com/in/subramdas",
      "github": "https://github.com/SubramDas"
    },
    "summary": "Tailored professional summary emphasizing JD keywords...",
    "competencies": ["Keyword 1", "Keyword 2", "Keyword 3", "Keyword 4"],
    "experience": [
      {
        "company": "KPIT Technologies",
        "role": "Senior Software Engineer",
        "dates": "June 2025 - Present",
        "location": "Pune, India",
        "bullets": ["Achievement 1 with metrics from cv.md", "Achievement 2"]
      }
    ],
    "projects": [
      {
        "name": "Project Name from cv.md",
        "tech": "Relevant technologies",
        "bullets": ["Project bullet 1", "Project bullet 2"]
      }
    ],
    "education": [
      {
        "title": "Bachelor of Technology (B.Tech)",
        "org": "Indian Institute of Technology, Bombay",
        "year": "2021 - 2025",
        "location": "Mumbai, India"
      }
    ],
    "skills": [
      {
        "category": "Languages & Systems",
        "items": "C, C++, Python, Linux..."
      }
    ]
  }
}`;

    console.log('Sending prompt to Gemini...');
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const data = JSON.parse(responseText);

    console.log(`Evaluated: ${data.role} @ ${data.company} (Score: ${data.score})`);

    // Prepare temp payload file
    const outputDir = join(ROOT, 'output');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    const payloadPath = join(outputDir, 'cv-payload.json');
    const htmlPath = join(outputDir, 'cv.html');
    const pdfPath = join(outputDir, 'resume.pdf');

    writeFileSync(payloadPath, JSON.stringify(data.cv_payload, null, 2));

    console.log('Building HTML...');
    execFileSync('node', ['build-cv-html.mjs', payloadPath, htmlPath], {
      cwd: ROOT,
      stdio: 'inherit',
    });

    console.log('Compiling PDF with Playwright...');
    execFileSync('node', [
      'generate-pdf.mjs',
      htmlPath,
      pdfPath,
      '--format=a4',
      '--allow-reorder',
      '--skip-fact-check'
    ], {
      cwd: ROOT,
      stdio: 'inherit',
    });

    // -----------------------------------------------------------------------
    // Format Telegram Messages
    // -----------------------------------------------------------------------
    const strengthsList = (data.strengths || []).map(s => `• ${s}`).join('\n');
    const gapsList = (data.gaps || []).map(g => `• ${g}`).join('\n') || '• None detected';

    const summaryMessage = 
`🎯 <b>${data.role}</b> @ <b>${data.company}</b>
⭐ <b>Fit Score:</b> ${data.score}

📋 <b>Summary:</b>
${data.fit_summary}

✅ <b>Strengths:</b>
${strengthsList}

⚠️ <b>Gaps / Watchouts:</b>
${gapsList}`;

    const answersMessage = 
`📝 <b>Application Form Answers:</b>

<b>1. Why are you interested in this role?</b>
${data.form_answers.why_role}

<b>2. Why do you want to work at ${data.company}?</b>
${data.form_answers.why_company}

<b>3. Relevant project / achievement:</b>
${data.form_answers.relevant_project}`;

    console.log('Sending messages to Telegram...');
    await sendTelegramMessage(summaryMessage);
    await sendTelegramMessage(answersMessage);

    console.log('Sending resume.pdf to Telegram...');
    await sendTelegramDocument(pdfPath, `📄 Tailored Resume: ${data.role} @ ${data.company}`);

    console.log('Pipeline completed successfully!');
  } catch (error) {
    console.error('Pipeline error:', error);
    await sendTelegramMessage(`❌ Pipeline failed: ${error.message}`);
    process.exit(1);
  }
}

main();
