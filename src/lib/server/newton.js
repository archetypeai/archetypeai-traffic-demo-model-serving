import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATAI_API_KEY, ATAI_API_ENDPOINT } from '$env/static/private';

function apiUrl(path) {
	const root = ATAI_API_ENDPOINT.replace(/\/$/, '').replace(/\/api$/, '');
	return `${root}/api${path}`;
}

// Inference API model names. Fusion is a reasoning model: `/no_think` at the end of the query keeps its
// <think> block empty. `/think` does NOT force reasoning (the block stays empty),
// so think mode sends no switch and lets the model decide; on the default
// traffic prompt it then reasons for 4-6k characters, hence the larger budget.
// On dense night scenes greedy reasoning loops while counting cars
// ("1 white car. 1 red car. ...") and never closes <think>; a mild repetition
// penalty broke the loop in every test. C 2.6 never emits a think block.
export const MODES = {
	'fusion-no-think': { model: 'newton-fusion-1.0', suffix: ' /no_think', maxNewTokens: 512 },
	'fusion-think': {
		model: 'newton-fusion-1.0',
		suffix: '',
		maxNewTokens: 4096,
		params: { repetition_penalty: 1.1 }
	},
	c26: { model: 'newton-c-2.6', suffix: '', maxNewTokens: 512 }
};
export const DEFAULT_MODE = 'c26';

// Drop the think block. One never closed means the budget ran out mid-reasoning
// and there is no answer to show.
function stripThinking(text) {
	if (/^\s*<think>/.test(text) && !text.includes('</think>')) {
		throw new Error('The model ran out of tokens while reasoning and gave no answer');
	}
	return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
}

function extractText(payload) {
	const inner = payload?.response;
	if (inner?.success === false) throw new Error(`Model returned success=false: ${JSON.stringify(inner)}`);
	const text = Array.isArray(inner?.response) ? inner.response[0] : inner?.response;
	if (typeof text !== 'string') throw new Error(`Unexpected response: ${JSON.stringify(payload)}`);
	const answer = stripThinking(text).trim();
	if (!answer) throw new Error('The model returned an empty answer');
	return answer;
}

function run(cmd, args) {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
		let stderr = '';
		proc.stderr.on('data', (d) => (stderr += d));
		proc.on('error', (err) =>
			reject(err.code === 'ENOENT' ? new Error('ffmpeg not found on PATH (brew install ffmpeg)') : err)
		);
		proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))));
	});
}

// The Inference API's /query takes video only as an encoded clip in `file_ids`
// (`data.base64_img` events and `multi_image` are refused), so the captured
// JPEG frames are muxed into a short H.264 MP4 at the rate they were sampled.
async function framesToMp4(frames, fps) {
	const dir = await mkdtemp(join(tmpdir(), 'traffic-clip-'));
	try {
		await Promise.all(
			frames.map((b64, i) => writeFile(join(dir, `f${String(i).padStart(3, '0')}.jpg`), Buffer.from(b64, 'base64')))
		);
		const out = join(dir, 'clip.mp4');
		await run('ffmpeg', [
			'-loglevel', 'error',
			'-framerate', String(fps),
			'-i', join(dir, 'f%03d.jpg'),
			'-c:v', 'libx264',
			'-pix_fmt', 'yuv420p',
			'-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
			'-movflags', '+faststart',
			out
		]);
		return (await readFile(out)).toString('base64');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// Stateless POST /api/inference/query on the Inference API. The frames go
// up as one MP4 clip; the system turn in `system_prompt`, the question in `query`.
export async function analyzeFrames(frames, instruction, query, { rawFps = 1, mode = DEFAULT_MODE, timeoutMs = 120000 } = {}) {
	const { model, suffix, maxNewTokens, params } = MODES[mode] ?? MODES[DEFAULT_MODE];
	const clip = await framesToMp4(frames, rawFps);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(apiUrl('/inference/query'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${ATAI_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model,
				query: query + suffix,
				system_prompt: instruction,
				file_ids: [`base64:${clip}`],
				max_new_tokens: maxNewTokens,
				...params
			}),
			signal: controller.signal
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(`POST /api/inference/query failed: ${res.status} - ${JSON.stringify(err)}`);
		}
		return extractText(await res.json());
	} finally {
		clearTimeout(timeoutId);
	}
}
