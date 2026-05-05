import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

export interface LiveStreamOptions {
	sizeThresholdWords: number;
	timeThresholdMs: number;
	/** Optional ceiling — flush a batch once this many chunks accumulate, even
	 * if neither word nor time threshold has fired. Protects against sparse /
	 * quiet speech where individual chunks contribute few words and timestamps
	 * may not advance steadily. */
	chunkCountThreshold?: number;
	/** When resuming an existing meeting, incoming chunks have timestamps
	 * starting at 0 (the new capture session's clock). Add this offset to
	 * keep the transcript array monotonic across the original + resumed
	 * segments. Defaults to 0. */
	chunkOffsetMs?: number;
	signal: FeederSignal;
	/** Fires once per chunk as it arrives — useful for live captions. */
	onChunk?: (chunk: TranscriptChunk) => void;
}

/**
 * Consumes Tauri `transcript-chunk` events and yields batches when the
 * accumulated chunks cross the size or time threshold. Same shape as
 * `feedTranscriptBatches` so the meeting consumer code is identical
 * across demo and live modes.
 */
export async function* consumeLiveStream(
	opts: LiveStreamOptions,
): AsyncGenerator<Batch> {
	const queue: TranscriptChunk[] = [];
	let resolveNext: (() => void) | null = null;
	const offsetMs = opts.chunkOffsetMs ?? 0;

	const unlisten = await listen<TranscriptChunk>(
		"transcript-chunk",
		(event) => {
			const incoming = event.payload;
			// Offset both timestamps uniformly so per-batch elapsed-time math
			// (endMs - bufStartMs) is unaffected, while the transcript array
			// stays monotonic across the original + resumed segments.
			const chunk: TranscriptChunk =
				offsetMs === 0
					? incoming
					: {
							...incoming,
							startMs: incoming.startMs + offsetMs,
							endMs: incoming.endMs + offsetMs,
						};
			queue.push(chunk);
			opts.onChunk?.(chunk);
			if (resolveNext) {
				resolveNext();
				resolveNext = null;
			}
		},
	);

	try {
		let buf: TranscriptChunk[] = [];
		let words = 0;
		let bufStartMs = 0;

		while (!opts.signal.cancelled) {
			while (queue.length === 0 && !opts.signal.cancelled) {
				await new Promise<void>((r) => {
					resolveNext = r;
				});
			}
			if (opts.signal.cancelled) return;

			const chunk = queue.shift();
			if (!chunk) continue;
			if (buf.length === 0) bufStartMs = chunk.startMs;
			buf.push(chunk);
			words += wordCount(chunk.text);

			const elapsed = chunk.endMs - bufStartMs;
			const sizeMet = words >= opts.sizeThresholdWords;
			const timeMet = elapsed >= opts.timeThresholdMs;
			const countMet =
				opts.chunkCountThreshold !== undefined &&
				buf.length >= opts.chunkCountThreshold;
			if (sizeMet || timeMet || countMet) {
				yield { chunks: buf, wordCount: words };
				buf = [];
				words = 0;
			}
		}
	} finally {
		unlisten();
	}
}

export interface AudioImportStreamOptions {
	/** The pending-import id; events with a different `importId` are ignored. */
	importId: string;
	sizeThresholdWords: number;
	timeThresholdMs: number;
	/** Optional ceiling — flush a batch once this many chunks accumulate. */
	chunkCountThreshold?: number;
	signal: FeederSignal;
	/** Fires once per chunk as it arrives. */
	onChunk?: (chunk: TranscriptChunk) => void;
	/** Fires once when the backend reports `audio-import-done`. */
	onDone?: (segmentCount: number) => void;
	/** Fires once when the backend reports `audio-import-error`. */
	onError?: (message: string) => void;
}

/**
 * AIZ-47 — consumes Tauri `audio-import-segment` events emitted by the
 * Rust whisper worker and yields batches in the same shape as
 * `feedTranscriptBatches`. Generator returns when `audio-import-done`
 * fires for the matching `importId` or when the signal is cancelled;
 * throws when `audio-import-error` fires.
 */
export async function* consumeAudioImportStream(
	opts: AudioImportStreamOptions,
): AsyncGenerator<Batch> {
	const queue: TranscriptChunk[] = [];
	let resolveNext: (() => void) | null = null;
	let streamFinished = false;
	let streamError: string | null = null;

	const wakeWaiter = () => {
		if (resolveNext) {
			resolveNext();
			resolveNext = null;
		}
	};

	const unlistenSegment: UnlistenFn = await listen<{
		importId: string;
		chunk: TranscriptChunk;
	}>("audio-import-segment", (event) => {
		if (event.payload.importId !== opts.importId) return;
		const chunk = event.payload.chunk;
		queue.push(chunk);
		opts.onChunk?.(chunk);
		wakeWaiter();
	});

	const unlistenDone: UnlistenFn = await listen<{
		importId: string;
		segmentCount: number;
	}>("audio-import-done", (event) => {
		if (event.payload.importId !== opts.importId) return;
		streamFinished = true;
		opts.onDone?.(event.payload.segmentCount);
		wakeWaiter();
	});

	const unlistenError: UnlistenFn = await listen<{
		importId: string;
		message: string;
	}>("audio-import-error", (event) => {
		if (event.payload.importId !== opts.importId) return;
		streamFinished = true;
		streamError = event.payload.message;
		opts.onError?.(event.payload.message);
		wakeWaiter();
	});

	try {
		let buf: TranscriptChunk[] = [];
		let words = 0;
		let bufStartMs = 0;

		while (!opts.signal.cancelled) {
			while (queue.length === 0 && !streamFinished && !opts.signal.cancelled) {
				await new Promise<void>((r) => {
					resolveNext = r;
				});
			}
			if (opts.signal.cancelled) return;

			// Drain anything we've buffered before honoring `streamFinished`,
			// so the trailing partial batch still flushes.
			const chunk = queue.shift();
			if (!chunk) {
				if (streamError) throw new Error(streamError);
				if (buf.length > 0) {
					yield { chunks: buf, wordCount: words };
				}
				return;
			}

			if (buf.length === 0) bufStartMs = chunk.startMs;
			buf.push(chunk);
			words += wordCount(chunk.text);

			const elapsed = chunk.endMs - bufStartMs;
			const sizeMet = words >= opts.sizeThresholdWords;
			const timeMet = elapsed >= opts.timeThresholdMs;
			const countMet =
				opts.chunkCountThreshold !== undefined &&
				buf.length >= opts.chunkCountThreshold;
			if (sizeMet || timeMet || countMet) {
				yield { chunks: buf, wordCount: words };
				buf = [];
				words = 0;
			}
		}
	} finally {
		unlistenSegment();
		unlistenDone();
		unlistenError();
	}
}
