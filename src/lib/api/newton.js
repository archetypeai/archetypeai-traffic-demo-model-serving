// Stateless analysis against the Inference API (Newton C 2.6 or Fusion 1.0) — no session lifecycle.
// Each call sends a short window of frames as one video clip; `rawFps` is the
// sampling rate the frames were captured at (the server encodes the MP4 at that rate).
// `mode` picks the model: 'fusion-no-think' | 'fusion-think' | 'c26'.
export async function analyze(frames, query, rawFps, mode) {
	const body = { frames, mode };
	if (query) body.query = query;
	if (rawFps) body.rawFps = rawFps;

	const res = await fetch('/api/analyze', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.error || 'Analysis failed');
	}
	return res.json();
}
