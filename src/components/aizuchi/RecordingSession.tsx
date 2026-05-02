import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

type Phase =
	| "idle"
	| "recording"
	| "downloading"
	| "transcribing"
	| "live"
	| "done"
	| "error";

interface PhasePayload {
	phase: Phase;
	label: string;
}

interface TranscriptChunk {
	speaker: string;
	text: string;
	startMs: number;
	endMs: number;
}

export function RecordingSession() {
	const [phase, setPhase] = useState<Phase>("recording");
	const [label, setLabel] = useState<string>("Recording…");
	const [level, setLevel] = useState(0);
	const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		// Pull the current phase on mount so we don't miss events emitted
		// before this window's React subscribers were ready.
		invoke<[string, string]>("get_audio_phase")
			.then(([p, l]) => {
				setPhase(p as Phase);
				setLabel(l);
			})
			.catch(() => {});

		const phaseUnlisten = listen<PhasePayload>("audio-phase", (event) => {
			setPhase(event.payload.phase);
			setLabel(event.payload.label);
		});
		const levelUnlisten = listen<number>("audio-level", (event) => {
			setLevel(event.payload);
		});
		const chunkUnlisten = listen<TranscriptChunk>(
			"transcript-chunk",
			(event) => {
				setChunks((prev) => [...prev, event.payload]);
			},
		);
		return () => {
			phaseUnlisten.then((fn) => fn()).catch(() => {});
			levelUnlisten.then((fn) => fn()).catch(() => {});
			chunkUnlisten.then((fn) => fn()).catch(() => {});
		};
	}, []);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [chunks]);

	const scale = 0.55 + Math.min(level, 1) * 0.85;
	const opacity = 0.35 + Math.min(level, 1) * 0.55;

	const handleStop = () => {
		invoke("stop_live_capture").catch(() => {});
	};

	const isLive = phase === "live";

	return (
		<div className="flex h-screen w-screen flex-col rounded-[14px] border border-white/10 bg-black/55 text-white backdrop-blur-2xl">
			<div className="flex flex-col items-center gap-4 px-6 pt-6">
				<Visual phase={phase} scale={scale} opacity={opacity} />
				<div className="text-center">
					<div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
						{phase}
					</div>
					<div className="mt-1 text-base font-medium text-white">{label}</div>
				</div>
				{isLive && (
					<button
						type="button"
						onClick={handleStop}
						className="rounded-full bg-red-600/90 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
					>
						Stop
					</button>
				)}
			</div>

			{isLive && (
				<div
					ref={scrollRef}
					className="mt-4 flex-1 overflow-y-auto border-t border-white/10 px-5 py-3"
				>
					{chunks.length === 0 ? (
						<div className="text-center text-xs italic text-white/40">
							Listening — transcript will appear here as you speak…
						</div>
					) : (
						<div className="space-y-1.5">
							{chunks.map((chunk, i) => (
								<div
									key={`${chunk.startMs}-${i}`}
									className="text-sm leading-snug"
								>
									<span className="mr-2 text-[10px] font-semibold uppercase tracking-wide text-white/40">
										{chunk.speaker}
									</span>
									<span className="text-white/90">{chunk.text}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function Visual({
	phase,
	scale,
	opacity,
}: {
	phase: Phase;
	scale: number;
	opacity: number;
}) {
	if (phase === "recording" || phase === "live") {
		return (
			<motion.div
				animate={{ scale, opacity }}
				transition={{ type: "spring", stiffness: 220, damping: 22 }}
				className="size-16 rounded-full bg-red-500"
			/>
		);
	}
	if (phase === "downloading" || phase === "transcribing") {
		return (
			<motion.div
				animate={{ rotate: 360 }}
				transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
				className="size-14 rounded-full border-4 border-white/15 border-t-white/80"
			/>
		);
	}
	if (phase === "done") {
		return (
			<motion.div
				initial={{ scale: 0.6, opacity: 0 }}
				animate={{ scale: 1, opacity: 1 }}
				transition={{ type: "spring", stiffness: 280, damping: 20 }}
				className="flex size-16 items-center justify-center rounded-full bg-emerald-500/90 text-2xl"
			>
				✓
			</motion.div>
		);
	}
	if (phase === "error") {
		return (
			<div className="flex size-16 items-center justify-center rounded-full bg-red-500/80 text-2xl">
				✕
			</div>
		);
	}
	return <div className="size-16 rounded-full bg-white/15" />;
}
