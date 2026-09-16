import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROSTER } from './roster.mjs';

// Generates one portrait per team member with Replicate (Flux Schnell). The key is read from
// the untracked .env or REPLICATE_API_KEY; portraits are committed so the dashboard needs no key.
const root = path.dirname(fileURLToPath(import.meta.url));
const STYLE = 'stylized character portrait, head and shoulders, flat vector illustration with subtle grain, dark slate background, two-tone amber and teal lighting, bold simple shapes, no text, no watermark, centered, square';
const LOOKS = {
  'team-coordinator': 'a calm hive-mind entity made of many faint overlapping faces and glowing nodes, symmetrical, serene, unsettling',
  'team-pm': 'a bald executive with a wide confident grin and intense eyes, crisp shirt, laser focus, ambitious energy',
  'team-ux': 'an elderly minimalist industrial designer with round glasses and a grey turtleneck, quiet exacting gaze',
  'team-dev': 'an old wizard with a long grey beard and pointed hat, twinkling eyes, holding a glowing keyboard like a staff',
  'team-tester': 'a grinning trickster with smeared clown makeup and wild green hair, holding a broken gadget, mischievous',
  'team-reviewer': 'an anthropomorphic onion with a stern furrowed brow and small reading glasses, peeling one layer, judgmental',
  'team-ideation': 'a visionary in a black turtleneck and round glasses, one hand raised mid-reveal, stage spotlight',
  'team-owner': 'a discreet butler-like android with a polite neutral expression, subtle blue interface glow',
};

function apiKey() {
  if (process.env.REPLICATE_API_KEY) return process.env.REPLICATE_API_KEY;
  try { return /^REPLICATE_API_KEY=(\S+)$/m.exec(readFileSync(path.join(root, '.env'), 'utf8'))?.[1]; } catch { return undefined; }
}

async function generate(key, prompt) {
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'wait=60' };
  const response = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', { method: 'POST', headers,
    body: JSON.stringify({ input: { prompt, aspect_ratio: '1:1', output_format: 'webp', output_quality: 85, num_outputs: 1, go_fast: true } }) });
  if (!response.ok) throw new Error(`Replicate request failed (${response.status})`);
  let prediction = await response.json();
  while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const poll = await fetch(prediction.urls.get, { headers });
    if (!poll.ok) throw new Error(`Replicate poll failed (${poll.status})`);
    prediction = await poll.json();
  }
  if (prediction.status !== 'succeeded') throw new Error(`Generation ${prediction.status}`);
  const image = await fetch(Array.isArray(prediction.output) ? prediction.output[0] : prediction.output);
  if (!image.ok) throw new Error('Portrait download failed');
  return Buffer.from(await image.arrayBuffer());
}

export async function main(args = process.argv.slice(2)) {
  const key = apiKey();
  if (!key) throw new Error('REPLICATE_API_KEY is required (environment or .env)');
  const force = args.includes('--force');
  const only = args.filter(arg => !arg.startsWith('--'));
  const dir = path.join(root, 'portraits');
  mkdirSync(dir, { recursive: true });
  for (const [role, member] of Object.entries(ROSTER)) {
    if (only.length && !only.includes(role)) continue;
    const file = path.join(dir, `${role}.webp`);
    if (existsSync(file) && !force) { console.log(`kept ${file}`); continue; }
    const prompt = `${LOOKS[role] ?? member.voice}, ${STYLE}`;
    writeFileSync(file, await generate(key, prompt));
    console.log(`wrote ${file}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
