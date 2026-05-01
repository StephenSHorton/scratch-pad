import { wordCount } from "./batcher";
import type { TranscriptChunk } from "./schemas";

export interface Batch {
	chunks: TranscriptChunk[];
	wordCount: number;
}

export interface FeederSignal {
	cancelled: boolean;
	paused: boolean;
}

export interface FeederOptions {
	sizeThresholdWords: number;
	timeThresholdMs: number;
	/** 1 = real conversation pace, 4 = 4x faster, etc. */
	speedMultiplier?: number;
	signal: FeederSignal;
	/** Fires once per chunk as it "arrives" — useful for live captions. */
	onChunk?: (chunk: TranscriptChunk) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitWhilePaused(signal: FeederSignal, intervalMs = 100) {
	while (signal.paused && !signal.cancelled) {
		await sleep(intervalMs);
	}
}

/**
 * Yields batches paced by the chunks' own timestamps. Each chunk is
 * delivered after a real wall-clock delay derived from its startMs gap to
 * the previous chunk (divided by speedMultiplier). Batches fire as soon as
 * the buffered chunks cross the size or time threshold — same logic as the
 * synchronous batcher, but driven by elapsed time rather than tight-loop
 * iteration.
 *
 * Designed as the integration shape for real ASR: swap the static fixture
 * for a streaming chunk source and the consumer code is unchanged.
 */
export async function* feedTranscriptBatches(
	chunks: TranscriptChunk[],
	opts: FeederOptions,
): AsyncGenerator<Batch> {
	const speed = opts.speedMultiplier ?? 4;
	let buf: TranscriptChunk[] = [];
	let words = 0;
	let bufStartMs = chunks[0]?.startMs ?? 0;
	let prevChunkStartMs = chunks[0]?.startMs ?? 0;

	for (let i = 0; i < chunks.length; i++) {
		if (opts.signal.cancelled) return;
		if (opts.signal.paused) await waitWhilePaused(opts.signal);
		if (opts.signal.cancelled) return;

		const chunk = chunks[i];
		if (i > 0) {
			const realDelay = (chunk.startMs - prevChunkStartMs) / speed;
			if (realDelay > 0) await sleep(realDelay);
			if (opts.signal.cancelled) return;
			if (opts.signal.paused) await waitWhilePaused(opts.signal);
			if (opts.signal.cancelled) return;
		}
		prevChunkStartMs = chunk.startMs;

		opts.onChunk?.(chunk);
		buf.push(chunk);
		words += wordCount(chunk.text);

		const elapsed = chunk.endMs - bufStartMs;
		const sizeMet = words >= opts.sizeThresholdWords;
		const timeMet = elapsed >= opts.timeThresholdMs;

		if (sizeMet || timeMet) {
			yield { chunks: buf, wordCount: words };
			buf = [];
			words = 0;
			bufStartMs = chunk.endMs;
		}
	}

	if (buf.length > 0 && !opts.signal.cancelled) {
		yield { chunks: buf, wordCount: words };
	}
}
