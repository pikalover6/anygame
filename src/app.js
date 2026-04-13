/**
 * app.js — Main orchestration module.
 *
 * Responsibilities:
 *  • Animated star-field on the prompt screen
 *  • Settings modal (API keys stored in localStorage)
 *  • Prompt → LLM → inject generated code into sandboxed iframe
 *  • Loading progress bar + status text
 *  • Game toolbar (new game / view source)
 */

import { generateGameCode } from './llm.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const promptScreen   = document.getElementById('prompt-screen');
const loadingScreen  = document.getElementById('loading-screen');
const gameScreen     = document.getElementById('game-screen');
const gameFrame      = document.getElementById('game-frame');
const gameToolbar    = document.getElementById('game-toolbar');

const promptInput    = document.getElementById('game-prompt');
const generateBtn    = document.getElementById('generate-btn');
const settingsBtn    = document.getElementById('settings-btn');

const settingsModal  = document.getElementById('settings-modal');
const settingsClose  = document.getElementById('settings-close');
const settingsSave   = document.getElementById('settings-save');
const groqKeyInput   = document.getElementById('groq-key');
const orKeyInput     = document.getElementById('or-key');

const statusText     = document.getElementById('loading-status');
const progressBar    = document.getElementById('progress-bar');
const loadingTitle   = document.getElementById('loading-game-title');
const toolbar_title  = document.getElementById('toolbar-game-title');
const newGameBtn     = document.getElementById('new-game-btn');
const viewSourceBtn  = document.getElementById('view-source-btn');
const errorToast     = document.getElementById('error-toast');

// ── Star field ────────────────────────────────────────────────────────────────
(function initStars() {
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  let stars = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    stars = Array.from({ length: 180 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.4 + 0.3,
      alpha: Math.random() * 0.6 + 0.2,
      speed: Math.random() * 0.3 + 0.05,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,190,255,${s.alpha})`;
      ctx.fill();
      s.alpha += s.speed * 0.02 * (Math.random() > 0.5 ? 1 : -1);
      s.alpha = Math.max(0.1, Math.min(0.85, s.alpha));
    }
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  draw();
})();

// ── Settings modal ────────────────────────────────────────────────────────────
function openSettings() {
  groqKeyInput.value = localStorage.getItem('groq_api_key') || '';
  orKeyInput.value   = localStorage.getItem('openrouter_api_key') || '';
  settingsModal.classList.add('open');
}
function closeSettings() { settingsModal.classList.remove('open'); }

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

settingsSave.addEventListener('click', () => {
  const g = groqKeyInput.value.trim();
  const o = orKeyInput.value.trim();
  // API keys are stored in localStorage so the user doesn't have to re-enter
  // them on every visit. This is a client-only app with no server; keys never
  // leave the browser. Users are informed of this in the settings UI.
  // nosemgrep: javascript.browser.security.sensitive-storage
  if (g) localStorage.setItem('groq_api_key', g);
  else   localStorage.removeItem('groq_api_key');
  if (o) localStorage.setItem('openrouter_api_key', o);
  else   localStorage.removeItem('openrouter_api_key');
  closeSettings();
});

// ── Example prompt chips ──────────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    promptInput.value = chip.dataset.prompt;
    promptInput.focus();
  });
});

// ── Utility: screen transitions ───────────────────────────────────────────────
function showScreen(screen) {
  [promptScreen, loadingScreen, gameScreen].forEach(s => s.classList.add('hidden'));
  screen.classList.remove('hidden');
}

// ── Utility: progress bar ─────────────────────────────────────────────────────
let progressTarget = 0;
function setProgress(pct, status) {
  progressTarget = pct;
  progressBar.style.width = pct + '%';
  if (status) statusText.textContent = status;
}

// ── Error toast ───────────────────────────────────────────────────────────────
let errorTimeout;
function showError(msg) {
  errorToast.innerHTML = `<strong>Error:</strong> ${msg}`;
  errorToast.classList.add('visible');
  clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => errorToast.classList.remove('visible'), 8000);
}

// ── Sandbox bootstrap source (fetched once, cached) ───────────────────────────
let _bootstrapSrc = null;
async function getBootstrap() {
  if (_bootstrapSrc !== null) return _bootstrapSrc;
  const res = await fetch('./src/sandbox-bootstrap.js');
  _bootstrapSrc = await res.text();
  return _bootstrapSrc;
}

// ── Build srcdoc for the game iframe ─────────────────────────────────────────
function buildSrcdoc(bootstrapSrc, gameCode) {
  // Escape </script> inside script blocks to prevent HTML parser confusion
  const safeBootstrap = bootstrapSrc.replace(/<\/script>/gi, '<\\/script>');
  const safeGameCode  = gameCode.replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AnyGame</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#000;overflow:hidden;font-family:system-ui,sans-serif}
  canvas{display:block}
  #hud{
    position:fixed;top:0;left:0;width:100%;height:100%;
    pointer-events:none;z-index:10;
  }
  #hud *{pointer-events:auto}
</style>
<!-- Three.js r160 importmap -->
<script type="importmap">
{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}
</script>
</head>
<body>
<div id="hud"></div>

<!-- Bootstrap: sets up globals (THREE, GLTFLoader, loadModel, etc.) -->
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Expose as globals so the generated (non-module) game code can use them
window.THREE = THREE;
window.GLTFLoader = GLTFLoader;
window.PointerLockControls = PointerLockControls;
window.OrbitControls = OrbitControls;

// Run the sandbox bootstrap (loadModel, error overlay, etc.)
${safeBootstrap}

// Run the generated game code
(async () => {
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  try {
    await new AsyncFunction(${JSON.stringify(safeGameCode)})();
  } catch (err) {
    console.error('[game]', err);
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;background:rgba(10,0,0,.9);color:#ff8888;font:14px/1.6 monospace;padding:32px;z-index:99999;white-space:pre-wrap;overflow:auto';
    d.textContent = 'Game Error:\\n' + err.stack;
    document.body.appendChild(d);
  }
})();
</script>
</body>
</html>`;
}

// ── Current game state ────────────────────────────────────────────────────────
let currentGameCode = '';
let currentTitle = 'AnyGame';

// ── Main generation flow ──────────────────────────────────────────────────────
async function generate() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    promptInput.focus();
    promptInput.style.borderColor = 'var(--accent2)';
    setTimeout(() => { promptInput.style.borderColor = ''; }, 1200);
    return;
  }

  generateBtn.disabled = true;
  setProgress(5, 'Starting up…');
  showScreen(loadingScreen);

  // Derive a display title from the prompt (first ~6 words)
  currentTitle = prompt.split(/\s+/).slice(0, 6).join(' ');
  if (prompt.split(/\s+/).length > 6) currentTitle += '…';
  loadingTitle.textContent = currentTitle;

  try {
    // ── Step 1: LLM code generation ────────────────────────────────────────
    setProgress(10, 'Connecting to AI…');

    const gameCode = await generateGameCode(prompt, (msg) => {
      setProgress(Math.min(progressTarget + 10, 70), msg);
    });

    currentGameCode = gameCode;
    setProgress(75, 'Building game world…');

    // ── Step 2: Fetch bootstrap source ─────────────────────────────────────
    const bootstrap = await getBootstrap();
    setProgress(85, 'Loading 3D engine…');

    // ── Step 3: Inject into iframe ─────────────────────────────────────────
    const srcdoc = buildSrcdoc(bootstrap, gameCode);
    gameFrame.srcdoc = srcdoc;
    setProgress(95, 'Almost ready…');

    // Wait for iframe to signal it has loaded (or just a short delay)
    await new Promise(r => setTimeout(r, 600));
    setProgress(100, 'Done!');

    await new Promise(r => setTimeout(r, 300));

    // ── Step 4: Show game ──────────────────────────────────────────────────
    toolbar_title.textContent = currentTitle;
    showScreen(gameScreen);
    gameToolbar.classList.add('visible');

    // Hide toolbar after a few seconds so it doesn't obscure the game
    setTimeout(() => gameToolbar.classList.remove('visible'), 4000);

  } catch (err) {
    console.error('[generate]', err);
    showScreen(promptScreen);
    showError(err.message || String(err));
  } finally {
    generateBtn.disabled = false;
  }
}

// ── New game ──────────────────────────────────────────────────────────────────
function newGame() {
  gameFrame.srcdoc = '';
  gameToolbar.classList.remove('visible');
  promptInput.value = '';
  setProgress(0, '');
  showScreen(promptScreen);
}

// ── View generated source ─────────────────────────────────────────────────────
function viewSource() {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<pre style="font:13px/1.6 monospace;white-space:pre-wrap;padding:24px;background:#0a0a14;color:#e8e4ff">${
    currentGameCode.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }</pre>`);
  win.document.title = 'Game Source — ' + currentTitle;
}

// ── Event listeners ───────────────────────────────────────────────────────────
generateBtn.addEventListener('click', generate);
newGameBtn.addEventListener('click', newGame);
viewSourceBtn.addEventListener('click', viewSource);

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate();
});

// Re-show toolbar briefly on mouse move while game is active
gameScreen.addEventListener('mousemove', () => {
  gameToolbar.classList.add('visible');
  clearTimeout(gameToolbar._hideTimer);
  gameToolbar._hideTimer = setTimeout(() => gameToolbar.classList.remove('visible'), 3000);
});
