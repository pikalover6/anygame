/**
 * llm.js — Multi-provider LLM integration with automatic fallback.
 *
 * Priority order:
 *   1. Groq          (free tier, fast, best code quality — user provides key)
 *   2. OpenRouter    (free models available — user provides key)
 *   3. Pollinations  (completely free, no key, uses GPT-4o/Claude backend)
 *
 * Each provider is tried in sequence; on failure the next is attempted.
 * Rate limit / TOS notes are respected via retry-after headers where provided.
 */

const SYSTEM_PROMPT = `You are an expert Three.js game developer. The user will describe a game and you will write COMPLETE, WORKING, SELF-CONTAINED JavaScript that implements it.

CRITICAL RULES:
1. Output ONLY raw JavaScript code — no markdown fences, no backticks, no prose.
2. Do NOT use any import or require statements.
3. Everything you need is already available as globals (listed below).
4. The code must be fully playable and fun from the first frame.

━━━ AVAILABLE GLOBALS ━━━
• THREE          — Three.js r160 (geometry, materials, lights, cameras, etc.)
• GLTFLoader     — new GLTFLoader() for loading .glb/.gltf files
• PointerLockControls — first-person mouse-look (attach to camera + domElement)
• OrbitControls  — orbit / third-person camera
• loadModel(keyword)  — async helper; searches open 3D model libraries and returns
                        a cloned THREE.Object3D ready to add to the scene.
                        Accepts descriptive English keywords.
                        Examples: 'pine tree', 'medieval knight', 'spaceship',
                        'rock boulder', 'wooden barrel', 'zombie', 'wolf',
                        'treasure chest', 'crystal', 'mushroom', 'torch',
                        'house', 'castle tower', 'car', 'dragon', 'robot'
• window.innerWidth / window.innerHeight — viewport size

━━━ REQUIRED STRUCTURE ━━━
async function init() {
  // 1. Create renderer, append to document.body
  // 2. Create scene (set background, fog)
  // 3. Set up camera
  // 4. Add lights
  // 5. Load models with:  const tree = await loadModel('pine tree');
  //    scene.add(tree); tree.position.set(x,y,z);
  //    Clone for multiple copies: const t2 = tree.clone(); scene.add(t2);
  // 6. Build terrain / world
  // 7. Set up controls (keyboard listeners, PointerLockControls, etc.)
  // 8. Start game loop
}
init().catch(console.error);

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta(); // use THREE.Clock
  // update game logic
  renderer.render(scene, camera);
}

━━━ GUIDELINES ━━━
• Handle window resize: renderer.setSize / camera.aspect update.
• Add a HUD using a fixed-position <div id="hud"> with innerHTML updates.
• For first-person: use PointerLockControls; lock on canvas click.
• For third-person: use OrbitControls or a manual follow-camera.
• Terrain: use THREE.PlaneGeometry (rotated -PI/2) displaced by Math.sin/cos
  patterns or random vertex offsets for hills. Give it a MeshLambertMaterial.
• Lighting: at minimum AmbientLight + DirectionalLight.
• Fog: scene.fog = new THREE.FogExp2(color, density) for atmosphere.
• Make the game loop fun — add score, health, win/lose conditions, NPCs that
  move, projectiles, collectibles, whatever fits the game description.
• Use delta time so the game runs consistently at any frame rate.
• DO NOT leave the screen blank — show something immediately even while models load.

The user's game:`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripFences(text) {
  // Extract content from the first fenced code block, even when there is prose before/after it.
  // LLMs sometimes return "Here is the code:\n```javascript\n...\n```" instead of raw code.
  const fenceMatch = text.match(/```(?:[a-z0-9]*)\r?\n([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // Fall back: strip leading/trailing fences if present at the start/end of the string.
  return text.replace(/^```[a-z0-9]*\r?\n?/i, '').replace(/```\s*$/i, '').trim();
}

// Remove ES module import/export declarations that are invalid in an AsyncFunction body.
// LLMs occasionally emit them despite being told not to; all needed globals are already
// provided as window.* properties so removing these is always safe.
function sanitizeCode(code) {
  // Remove import declarations — handles single-line and multi-line forms by matching
  // from the `import` keyword up to the closing quote+semicolon without relying on
  // line-boundary anchors (which would miss multi-line specifier lists).
  code = code.replace(/\bimport\s+(?:[\w$*{},\s]+?\s+from\s+)?['"][^'"]*['"]\s*;?/g, '');
  // Remove top-level export modifiers (export default / export { ... }) which are
  // likewise invalid in a function-body context.
  code = code.replace(/^export\s+default\s+/gm, '');
  code = code.replace(/\bexport\s*\{[\s\S]*?\}\s*;?/g, '');
  return code.trim();
}

async function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// ── Provider implementations ──────────────────────────────────────────────────

async function callGroq(userPrompt, apiKey) {
  const res = await fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 8192,
      }),
    }
  );

  if (res.status === 429) {
    const retry = res.headers.get('retry-after');
    throw Object.assign(new Error('Groq rate limit'), { retryAfter: Number(retry) || 60 });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return stripFences(data.choices[0].message.content);
}

async function callOpenRouter(userPrompt, apiKey) {
  // Free models on OpenRouter — try in order of capability
  const FREE_MODELS = [
    'google/gemini-2.0-flash-exp:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1:free',
    'qwen/qwen3-30b-a3b:free',
  ];

  let lastErr;
  for (const model of FREE_MODELS) {
    try {
      const res = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/pikalover6/anygame',
            'X-Title': 'AnyGame',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.7,
            max_tokens: 8192,
          }),
        }
      );

      if (res.status === 429) {
        lastErr = new Error(`OpenRouter rate limit on ${model}`);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastErr = new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) { lastErr = new Error('OpenRouter: empty response'); continue; }
      return stripFences(content);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('OpenRouter: all free models failed');
}

async function callPollinations(userPrompt) {
  // Pollinations.ai — completely free, no API key required.
  // Uses GPT-4o or Claude behind the scenes.
  const res = await fetchWithTimeout(
    'https://text.pollinations.ai/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        seed: Math.floor(Math.random() * 999999),
      }),
    },
    60000
  );

  if (res.status === 429) throw new Error('Pollinations rate limit — please wait a moment and try again');
  if (!res.ok) throw new Error(`Pollinations ${res.status}`);

  const text = await res.text();
  return stripFences(text);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate Three.js game code from a user prompt.
 * Tries providers in priority order; calls onStatus(msg) with progress updates.
 *
 * @param {string} userPrompt
 * @param {function} onStatus
 * @returns {Promise<string>} Raw JavaScript game code
 */
export async function generateGameCode(userPrompt, onStatus = () => {}) {
  const groqKey = localStorage.getItem('groq_api_key')?.trim();
  const orKey = localStorage.getItem('openrouter_api_key')?.trim();

  const providers = [];

  if (groqKey) {
    providers.push({
      name: 'Groq (Llama 3.3 70B)',
      fn: () => callGroq(userPrompt, groqKey),
    });
  }
  if (orKey) {
    providers.push({
      name: 'OpenRouter',
      fn: () => callOpenRouter(userPrompt, orKey),
    });
  }
  // Pollinations is always the final option (no key needed)
  providers.push({
    name: 'Pollinations AI',
    fn: () => callPollinations(userPrompt),
  });

  let lastError;
  for (const provider of providers) {
    try {
      onStatus(`Generating with ${provider.name}…`);
      const raw = await provider.fn();
      const code = sanitizeCode(raw);
      if (!code || code.length < 100) throw new Error('Response too short — likely an error');
      return code;
    } catch (err) {
      console.warn(`[llm] ${provider.name} failed:`, err.message);
      onStatus(`${provider.name} failed — trying next provider…`);
      lastError = err;
    }
  }

  throw lastError || new Error('All LLM providers failed');
}
