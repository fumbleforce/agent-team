import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Viewport } from '@agent-team/protocol';
import { killTree, resolveBinary, spawnCommand } from './platform.ts';

// A page capture is one headless run of a locally installed Chromium-family browser, driven by its command line alone.
export const VIEWPORTS: Record<Viewport, { width: number; height: number }> = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1180 }, mobile: { width: 390, height: 844 } };
const BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'msedge', 'microsoft-edge'];
const CAPTURE_TIMEOUT_MS = 30_000;

export interface CaptureExecResult { code: number | null; timedOut: boolean; stderr: string }
export type CaptureExec = (bin: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<CaptureExecResult>;
export interface CaptureInput { url: string; viewport: Viewport; outFile: string; exec?: CaptureExec; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; browser?: string | null }
export interface CaptureResult { file: string; latencyMs: number }
export type CaptureFn = (input: CaptureInput) => Promise<CaptureResult>;

// Only web addresses: a file: or internal browser address would read the worker's own disk or settings.
export function captureUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('The address to capture is not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https addresses are captured, not ${url.protocol}`);
  return url.href;
}

export function captureArgs(input: { url: string; viewport: Viewport; outFile: string }): string[] {
  const size = VIEWPORTS[input.viewport];
  if (!size) throw new Error(`Unknown viewport "${String(input.viewport)}"`);
  // The address comes last and, once normalized, starts with http, so it can never be read as a switch.
  return ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--window-size=${size.width},${size.height}`, `--screenshot=${input.outFile}`, captureUrl(input.url)];
}

const isFile = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };

function installed(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    return roots.flatMap(root => [path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.win32.join(root, 'Chromium', 'Application', 'chrome.exe')]);
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return [];
}

function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return resolveBinary(name, { env, platform });
  for (const directory of (env.PATH ?? '').split(':')) if (directory && isFile(path.posix.join(directory, name))) return path.posix.join(directory, name);
  return null;
}

// AGENT_TEAM_BROWSER wins and is never second-guessed; otherwise the usual names on PATH, then the usual install places.
export function findBrowser({ env = process.env, platform = process.platform, exists = existsSync }: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (file: string) => boolean } = {}): string | null {
  const named = env.AGENT_TEAM_BROWSER?.trim();
  if (named) return /[\\/]/.test(named) ? (exists(named) ? named : null) : onPath(named, env, platform);
  for (const name of BROWSER_NAMES) { const found = onPath(name, env, platform); if (found) return found; }
  return installed(env, platform).find(file => exists(file)) ?? null;
}

const run: CaptureExec = (bin, args, options) => new Promise((resolve, reject) => {
  const child = spawnCommand(bin, args, { env: options.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid, 'SIGKILL'); }, options.timeoutMs);
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, stderr }); });
});

export const capturePage: CaptureFn = async input => {
  const env = input.env ?? process.env;
  const args = captureArgs(input);
  const browser = input.browser === undefined ? findBrowser({ env, ...(input.platform ? { platform: input.platform } : {}) }) : input.browser;
  if (!browser) throw new Error('No browser found to capture with: install a Chromium-family browser on this worker or set AGENT_TEAM_BROWSER to its path');
  const started = Date.now();
  const result = await (input.exec ?? run)(browser, args, { timeoutMs: CAPTURE_TIMEOUT_MS, env });
  if (result.timedOut) throw new Error(`The capture did not finish within ${CAPTURE_TIMEOUT_MS / 1000} s`);
  if (result.code !== 0) throw new Error(`The browser exited with ${result.code}: ${result.stderr.trim().split('\n').at(-1)?.slice(0, 200) ?? ''}`.trim());
  if (!isFile(input.outFile) || statSync(input.outFile).size === 0) throw new Error('The browser finished without writing an image');
  return { file: input.outFile, latencyMs: Date.now() - started };
};
