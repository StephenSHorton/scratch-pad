import type { TranscriptChunk } from "./schemas";

export interface Batch {
	chunks: TranscriptChunk[];
	wordCount: number;
}

export function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

export function formatChunkBatch(batch: Batch): string {
	return batch.chunks.map((c) => `${c.speaker}: ${c.text}`).join("\n");
}

export function* batchTranscript(
	chunks: TranscriptChunk[],
	sizeThresholdWords: number,
	timeThresholdMs: number,
): Generator<Batch> {
	let buf: TranscriptChunk[] = [];
	let words = 0;
	let bufferStartedMs = chunks[0]?.startMs ?? 0;

	for (const chunk of chunks) {
		buf.push(chunk);
		words += wordCount(chunk.text);

		const elapsed = chunk.endMs - bufferStartedMs;
		const sizeMet = words >= sizeThresholdWords;
		const timeMet = elapsed >= timeThresholdMs;

		if (sizeMet || timeMet) {
			yield { chunks: buf, wordCount: words };
			buf = [];
			words = 0;
			bufferStartedMs = chunk.endMs;
		}
	}

	if (buf.length > 0) {
		yield { chunks: buf, wordCount: words };
	}
}
