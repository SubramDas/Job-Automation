#!/usr/bin/env node

/**
 * scripts/render-bot.mjs
 *
 * Interactive Telegram Bot server for Render.com (or any Node.js host):
 * - Binds an HTTP server to process.env.PORT (10000) for Render health checks and ping monitors.
 * - Long-polls Telegram for incoming messages.
 * - Supports multi-turn conversational review:
 *   1. User sends JD -> Bot analyzes gaps and asks questions.
 *   2. User replies with extra experience -> Bot updates CV, recalculates score, and sends PDF.
 */

import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID ? String(process.env.ALLOWED_CHAT_ID) : null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!BOT_TOKEN || !GEMINI_API_KEY) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN and GEMINI_API_KEY must be configured.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// In-Memory Session Store
// ---------------------------------------------------------------------------
// Map<chatId, { state: 'IDLE' | 'AWAITING_FEEDBACK', jdText, company, role, initialData }>
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { state: 'IDLE' });
  }
  return sessions.get(chatId);
}

// ---------------------------------------------------------------------------
// HTTP Server for Render Health Checks & Pingers
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Career-Ops Interactive Telegram Bot is running!\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP health server listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Telegram Helpers
// ---------------------------------------------------------------------------
async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const chunkSize = 4000;
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
      });
    }
  }
}

async function sendTelegramDocument(chatId, filePath, caption = '') {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const fileBuffer = readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });

  const formData = new FormData();
  formData.append('chat_id', chatId);
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
    throw new Error(`Failed to send document: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// JD Extraction Helper
// ---------------------------------------------------------------------------
async function resolveJdText(input) {
  if (/^https?:\/\//i.test(input.trim())) {
    try {
      const res = await fetch(input.trim(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const html = await res.text();
      const cleaned = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `Posting URL: ${input}\n\nContent:\n${cleaned.slice(0, 15000)}`;
    } catch (e) {
      return input;
    }
  }
  return input;
}

// ---------------------------------------------------------------------------
// Gemini AI Workflows
// ---------------------------------------------------------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  generationConfig: { responseMimeType: 'application/json' },
});

function loadProfileContext() {
  const cvPath = join(ROOT, 'cv.md');
  const profilePath = join(ROOT, 'config/profile.yml');
  const cvContent = existsSync(cvPath) ? readFileSync(cvPath, 'utf8') : '';
  const profileContent = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  return { cvContent, profileContent };
}

// Phase 1: Analyze JD, identify gaps, ask candidate for input
async function analyzeGaps(jdText) {
  const { cvContent, profileContent } = loadProfileContext();

  const prompt = `You are an expert career agent. Evaluate this Job Description (JD) against the candidate's resume and profile.
Identify the match score, role, company, strengths, and critically: what skills or requirements in the JD are MISSING or THIN in the candidate's CV?

CANDIDATE CV (Ground truth):
${cvContent}

PROFILE CONFIG:
${profileContent}

JOB DESCRIPTION:
${jdText}

Return strict JSON:
{
  "company": "Company Name",
  "role": "Job Title",
  "score": "3.8 / 5.0",
  "fit_summary": "2-3 sentence overview.",
  "strengths": ["Strength 1", "Strength 2"],
  "gaps": [
    "Specific missing requirement or technology 1",
    "Specific missing requirement or technology 2"
  ]
}`;

  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

// Phase 2: Finalize tailoring with candidate's feedback and generate payload
async function generateTailoredCvAndAnswers(jdText, userFeedback = '') {
  const { cvContent, profileContent } = loadProfileContext();

  const prompt = `You are an expert career agent. Generate the final tailored CV payload and application answers for this job.

CANDIDATE CV (Ground truth):
${cvContent}

PROFILE CONFIG:
${profileContent}

ADDITIONAL EXPERIENCE PROVIDED BY CANDIDATE IN THIS INTERACTION:
${userFeedback || 'None provided; use only cv.md facts.'}

JOB DESCRIPTION:
${jdText}

RULES:
1. Candidate object: name, email, phone, location, linkedin, github.
2. Incorporate the candidate's stated additional experience into relevant bullets or skills without fabricating anything beyond what the candidate stated.
3. Draft 3 strong application form answers: why interested in role, why company, relevant project/achievement.
4. Output recalculate fit score (e.g. 4.8 / 5.0).

Return strict JSON:
{
  "company": "Company Name",
  "role": "Job Title",
  "updated_score": "4.8 / 5.0",
  "summary_of_changes": "How candidate feedback improved the match.",
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
    "summary": "Tailored summary...",
    "competencies": ["Competency 1", "Competency 2", "Competency 3"],
    "experience": [
      {
        "company": "KPIT Technologies",
        "role": "Senior Software Engineer",
        "dates": "June 2025 - Present",
        "location": "Pune, India",
        "bullets": ["Bullet 1 with metrics", "Bullet 2"]
      }
    ],
    "projects": [
      {
        "name": "Project Name",
        "tech": "Tech stack",
        "bullets": ["Project bullet"]
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

  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

// ---------------------------------------------------------------------------
// PDF Generation
// ---------------------------------------------------------------------------
function compilePdf(cvPayload) {
  const payloadPath = '/tmp/cv-payload.json';
  const htmlPath = '/tmp/cv.html';
  const outputDir = join(ROOT, 'output');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const pdfPath = join(outputDir, 'resume.pdf');

  writeFileSync(payloadPath, JSON.stringify(cvPayload, null, 2));

  execFileSync('node', ['build-cv-html.mjs', payloadPath, htmlPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });

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

  return pdfPath;
}

// ---------------------------------------------------------------------------
// Message Router
// ---------------------------------------------------------------------------
async function handleUserMessage(chatId, text) {
  const session = getSession(chatId);
  const trimmed = text.trim();

  if (trimmed === '/start' || trimmed === '/help') {
    session.state = 'IDLE';
    await sendTelegramMessage(chatId,
`👋 <b>Welcome to Career-Ops Interactive Bot!</b>

<b>How to use:</b>
1. Paste any Job Description (JD) text or URL.
2. I will analyze the match and point out skills your CV doesn't currently cover.
3. You can tell me your experience on those skills.
4. I'll update your CV, recalculate your score, and send you the tailored <b>resume.pdf</b>!

Send me a JD to get started.`
    );
    return;
  }

  if (trimmed === '/cancel' || trimmed === '/reset') {
    session.state = 'IDLE';
    await sendTelegramMessage(chatId, '🔄 Session reset. Send a new JD whenever you are ready.');
    return;
  }

  // State 1: IDLE — User submits a new JD
  if (session.state === 'IDLE') {
    await sendTelegramMessage(chatId, '🔍 <i>Analyzing Job Description against your CV...</i>');

    const jdText = await resolveJdText(trimmed);
    const analysis = await analyzeGaps(jdText);

    session.state = 'AWAITING_FEEDBACK';
    session.jdText = jdText;
    session.analysis = analysis;

    const strengthsText = (analysis.strengths || []).map(s => `• ${s}`).join('\n');
    const gapsText = (analysis.gaps || []).map((g, i) => `${i + 1}. <b>${g}</b>`).join('\n');

    const gapMessage =
`🎯 <b>${analysis.role}</b> @ <b>${analysis.company}</b>
⭐ <b>Initial Match Score:</b> ${analysis.score}

📋 <b>Summary:</b>
${analysis.fit_summary}

✅ <b>Strengths in CV:</b>
${strengthsText}

⚠️ <b>Skills / Requirements missing or thin in your CV:</b>
${gapsText || 'None detected! Match is already strong.'}

💬 <b>Did you work with any of these?</b>
Reply with your experience (e.g. <i>"At KPIT I used X for Y..."</i>), and I will update your CV and boost your score.

Or send <b>/generate</b> to build your resume right now as is.`;

    await sendTelegramMessage(chatId, gapMessage);
    return;
  }

  // State 2: AWAITING_FEEDBACK — User replies with experience or /generate
  if (session.state === 'AWAITING_FEEDBACK') {
    const isSkip = trimmed === '/generate' || trimmed === '/skip';
    await sendTelegramMessage(chatId, '⚙️ <i>Tailoring your resume and compiling PDF with Playwright...</i>');

    const feedback = isSkip ? '' : trimmed;
    const finalData = await generateTailoredCvAndAnswers(session.jdText, feedback);

    const pdfPath = compilePdf(finalData.cv_payload);

    const resultMessage =
`🎉 <b>Tailored Resume Ready!</b>

⭐ <b>Updated Score:</b> ${finalData.updated_score}
${finalData.summary_of_changes ? `💡 <i>${finalData.summary_of_changes}</i>\n` : ''}
📝 <b>Draft Application Answers:</b>

<b>1. Why this role?</b>
${finalData.form_answers.why_role}

<b>2. Why ${finalData.company}?</b>
${finalData.form_answers.why_company}

<b>3. Relevant project / achievement:</b>
${finalData.form_answers.relevant_project}`;

    await sendTelegramMessage(chatId, resultMessage);
    await sendTelegramDocument(chatId, pdfPath, `📄 Tailored CV: ${finalData.role} @ ${finalData.company}`);

    session.state = 'IDLE';
    await sendTelegramMessage(chatId, '✅ Done! Send another JD anytime to start a new application.');
  }
}

// ---------------------------------------------------------------------------
// Telegram Long Polling Engine
// ---------------------------------------------------------------------------
async function startTelegramPolling() {
  // Clear any existing webhooks so long polling works directly
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
  } catch (err) {
    console.warn('deleteWebhook notice:', err.message);
  }

  let offset = 0;
  console.log('🤖 Telegram long-polling started...');

  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`);
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (msg && msg.text) {
            const chatId = String(msg.chat.id);
            if (ALLOWED_CHAT_ID && chatId !== ALLOWED_CHAT_ID) {
              await sendTelegramMessage(chatId, '⛔ Unauthorized user.');
              continue;
            }
            try {
              await handleUserMessage(chatId, msg.text);
            } catch (err) {
              console.error('Error handling user message:', err);
              await sendTelegramMessage(chatId, `❌ An error occurred: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.error('Polling connection error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

startTelegramPolling();
