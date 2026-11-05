import express from 'express';
import GigaChat from 'gigachat';
import { Agent } from 'node:https';
import dotenv from 'dotenv';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// ==========================================
// НАСТРОЙКА СЕРТИФИКАТОВ
// ==========================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const certPath = path.resolve(__dirname, 'certs', 'all_certs.pem');
if (fs.existsSync(certPath)) {
  process.env.NODE_EXTRA_CA_CERTS = certPath;
  console.log('✔ Путь к сертификатам установлен:', certPath);
} else {
  console.warn('⚠ ВНИМАНИЕ: Файл certs/all_certs.pem не найден!');
}
// Отключаем проверку TLS для Node.js (иначе GigaChat выдает self-signed certificate)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ==========================================
// СОЗДАНИЕ СЕРВЕРА
// ==========================================
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const httpsAgent = new Agent({ 
  rejectUnauthorized: false, // Отключаем проверку для конкретного агента
  keepAlive: true 
});

const giga = new GigaChat({
  credentials: process.env.GIGACHAT_CREDENTIALS,
  model: 'GigaChat',
  httpsAgent: httpsAgent,
  timeout: 600,
});

const sessions = new Map();

// Жесткий список вопросов
const questions = [
  "1. Название компании и сфера?",
  "2. Целевая аудитория и цель сайта?",
  "3. Какие разделы нужны?",
  "4. Желаемый стиль и цвета?",
  "5. Услуги и контакты?",
  "6. Примеры сайтов или пожелания?"
];

/* ============================================================
   ЭТАП 1: ОПРОСНИК
   ============================================================ */
app.post('/api/survey', async (req, res) => {
  try {
    const { sessionId, userMessage } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Нужен sessionId' });

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { answers: [], currentIndex: 0 });
      return res.json({ done: false, reply: questions[0] });
    }

    const session = sessions.get(sessionId);

    if (userMessage) {
      session.answers.push(userMessage);
      session.currentIndex++;
    }

    if (session.currentIndex >= 6) {
      const finalPrompt = `Создай сайт на основе следующих ответов клиента: ${session.answers.join(' | ')}`;
      return res.json({ done: true, prompt: finalPrompt });
    }

    res.json({ done: false, reply: questions[session.currentIndex] });

  } catch (err) {
    console.error('[survey]', err);
    res.status(500).json({ error: err.message || 'Ошибка' });
  }
});

/* ============================================================
   ЭТАП 2: ГЕНЕРАЦИЯ HTML-КОДА
   ============================================================ */
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Нужен prompt' });

    const completion = await giga.chat({
      messages: [
        {
          role: 'system',
          content: `Ты — Senior Frontend Developer. Напиши идеальный HTML/CSS код на основе ТЗ.
ПРАВИЛА:
1. Цвета и стиль бери из ТЗ.
2. В body добавь style="background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%); min-height: 100vh; font-family: 'Inter', sans-serif;"
3. Сделай шапку (header) и главный экран (hero) с крупным заголовком.
4. Разделы делай в виде карточек (.card) с box-shadow: 0 10px 30px rgba(0,0,0,0.1); border-radius: 16px; background: white; padding: 30px;.
5. ОБЯЗАТЕЛЬНО там, где должна быть картинка товара, напиши ровно такой текст (без тегов img): [IMG]описание картинки на английском[/IMG]. Например: [IMG]fashion woman dress[/IMG].
6. Верни ТОЛЬКО HTML. Начни с <!DOCTYPE html> и закончи </html>.`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    });

    let html = completion.choices[0]?.message.content || '';
    
    html = html.replace(/```html/gi, '').replace(/```/g, '').trim();
    
    const htmlStart = html.indexOf('<!DOCTYPE');
    const htmlStart2 = html.indexOf('<html');
    const startIndex = htmlStart !== -1 ? htmlStart : htmlStart2;
    
    if (startIndex !== -1) {
      html = html.substring(startIndex);
    } else {
      return res.status(500).json({ error: 'ИИ не сгенерировал HTML' });
    }

    const htmlEnd = html.lastIndexOf('</html>');
    if (htmlEnd !== -1) {
      html = html.substring(0, htmlEnd + 7);
    }

    // Очистка от битых картинок
    html = html.replace(/<img[^>]*>/gi, '');
    html = html.replace(/"\s*\/>/g, '');
    html = html.replace(/\/>/g, '');

    // Замена меток на красивые фото
    let imgIndex = 0;
    const images = [
      'https://images.unsplash.com/photo-1483985988355-763728e1935b?q=80&w=800&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1445205170230-053b83016050?q=80&w=800&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1539533113208-f6df8cc8b543?q=80&w=800&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?q=80&w=800&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?q=80&w=800&auto=format&fit=crop'
    ];

    html = html.replace(/\[IMG\](.*?)\[\/IMG\]/g, () => {
      const imageUrl = images[imgIndex % images.length];
      imgIndex++;
      return `<img src="${imageUrl}" alt="Товар" style="width: 100%; height: 300px; object-fit: cover; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">`;
    });

    html = html.replace(/\[IMAGE:\s*(.*?)\]/g, () => {
      const imageUrl = images[imgIndex % images.length];
      imgIndex++;
      return `<img src="${imageUrl}" alt="Товар" style="width: 100%; height: 300px; object-fit: cover; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">`;
    });

    res.json({ html });
  } catch (err) {
    console.error('[generate]', err);
    res.status(500).json({ error: err.message || 'Ошибка генерации' });
  }
});

/* ============================================================
   ЭТАП 3: ПУБЛИКАЦИЯ
   ============================================================ */
function zipHtml(html) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    
    archive.append(html, { name: 'index.html' });
    archive.append('/*\n  Content-Type: text/html; charset=utf-8\n', { name: '_headers' });
    
    archive.finalize();
  });
}

app.post('/api/publish-netlify', async (req, res) => {
  try {
    const { html, siteName } = req.body;
    const token = process.env.NETLIFY_TOKEN;
    const safeName = siteName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

    const siteRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: safeName }),
    });
    const site = await siteRes.json();
    if (!site.id) throw new Error(JSON.stringify(site));

    const zip = await zipHtml(html);
    
    const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`, 
        'Content-Type': 'application/zip',
        'Accept': 'application/json'
      },
      body: zip,
    });
    const deploy = await deployRes.json();

    let state = deploy.state;
    let tries = 0;
    while (state !== 'ready' && tries < 30) {
      await new Promise((r) => setTimeout(r, 2000));
      const check = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys/${deploy.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      state = (await check.json()).state;
      tries++;
    }

    res.json({ url: deploy.ssl_url || deploy.deploy_ssl_url || site.url });
  } catch (err) {
    console.error('[publish-netlify]', err);
    res.status(500).json({ error: err.message || 'Ошибка публикации' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n=========================================`);
  console.log(`✔ Сервер запущен: http://localhost:${PORT}`);
  console.log(`=========================================\n`);
});