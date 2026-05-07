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
	/** Fires when the backend reports `audio-import-progress` (each
	 * integer-percent advance during whisper inference). */
	onProgress?: (percent: number) => void;
	/** Fires once when the backend reports `audio-import-done`. */
	onDone?: (segmentCount: number) => void;
	/** Fires once when the backend reports `audio-import-error`. */
	onError?: (message: string) => void;
	/** AIZ-38 — fires for each `audio-import-phase` event. The backend
	 * emits one when entering each named stage of the import pipeline
	 * (`downloading-model` / `decoding` / `transcribing` / `staging`)
	 * plus throttled byte-level progress ticks during the model
	 * download. */
	onPhase?: (phase: AudioImportPhase) => void;
}

/**
 * AIZ-38 — payload of the `audio-import-phase` Tauri event. Backend
 * emits these in order: `downloading-model` (only on first run; multiple
 * ticks with byte counts) → `decoding` (no progress) → `transcribing`
 * (one initial tick, see also the existing `audio-import-progress`
 * event for percent updates) → `staging` (between whisper hitting 100%
 * and the final batch landing).
 */
export interface AudioImportPhase {
	phase: "downloading-model" | "decoding" | "transcribing" | "staging";
	label: string;
	bytes?: number;
	total?: number;
	percent?: number;
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

	const unlistenProgress: UnlistenFn = await listen<{
		importId: string;
		percent: number;
	}>("audio-import-progress", (event) => {
		if (event.payload.importId !== opts.importId) return;
		opts.onProgress?.(event.payload.percent);
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

	const unlistenPhase: UnlistenFn = await listen<
		{ importId: string } & AudioImportPhase
	>("audio-import-phase", (event) => {
		if (event.payload.importId !== opts.importId) return;
		const { phase, label, bytes, total, percent } = event.payload;
		opts.onPhase?.({ phase, label, bytes, total, percent });
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

			// Once whisper signals done, dump the entire remaining queue as
			// one final batch. The streaming case earns its keep while
			// whisper is still working — that's when the user wants the
			// graph to populate early. Past that point, splitting the
			// trailer into many small batches just adds gemma roundtrips
			// (and on a 5+ minute recording, each extra roundtrip is
			// visible to the user as another "thinking…" cycle). Gemma
			// handles one large drain batch fine because the audio import
			// path forces Substance mode, which already prompts the model
			// for paragraph-level reasoning.
			if (streamFinished) {
				while (queue.length > 0) {
					const chunk = queue.shift();
					if (!chunk) break;
					if (buf.length === 0) bufStartMs = chunk.startMs;
					buf.push(chunk);
					words += wordCount(chunk.text);
				}
				if (streamError) throw new Error(streamError);
				if (buf.length > 0) {
					yield { chunks: buf, wordCount: words };
				}
				return;
			}

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
		unlistenSegment();
		unlistenProgress();
		unlistenDone();
		unlistenError();
		unlistenPhase();
	}
}
