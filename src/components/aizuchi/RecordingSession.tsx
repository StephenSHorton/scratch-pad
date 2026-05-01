import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

type Phase = "idle" | "recording" | "downloading" | "transcribing" | "done" | "error";

interface PhasePayload {
	phase: Phase;
	label: string;
}

export function RecordingSession() {
	const [phase, setPhase] = useState<Phase>("recording");
	const [label, setLabel] = useState<string>("Recording…");
	const [level, setLevel] = useState(0);

	useEffect(() => {
		const phaseUnlisten = listen<PhasePayload>("audio-phase", (event) => {
			setPhase(event.payload.phase);
			setLabel(event.payload.label);
		});
		const levelUnlisten = listen<number>("audio-level", (event) => {
			setLevel(event.payload);
		});
		return () => {
			phaseUnlisten.then((fn) => fn()).catch(() => {});
			levelUnlisten.then((fn) => fn()).catch(() => {});
		};
	}, []);

	// Smoothed visual scale: level 0..1 → 0.55..1.4
	const scale = 0.55 + Math.min(level, 1) * 0.85;
	const opacity = 0.35 + Math.min(level, 1) * 0.55;

	return (
		<div className="flex h-screen w-screen items-center justify-center rounded-[14px] border border-white/10 bg-black/55 text-white backdrop-blur-2xl">
			<div className="flex flex-col items-center gap-6">
				<Visual phase={phase} scale={scale} opacity={opacity} />
				<div className="text-center">
					<div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
						{phase}
					</div>
					<div className="mt-1 text-base font-medium text-white">{label}</div>
				</div>
			</div>
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
	if (phase === "recording") {
		return (
			<motion.div
				animate={{ scale, opacity }}
				transition={{ type: "spring", stiffness: 220, damping: 22 }}
				className="size-20 rounded-full bg-red-500"
			/>
		);
	}
	if (phase === "downloading" || phase === "transcribing") {
		return (
			<motion.div
				animate={{ rotate: 360 }}
				transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
				className="size-16 rounded-full border-4 border-white/15 border-t-white/80"
			/>
		);
	}
	if (phase === "done") {
		return (
			<motion.div
				initial={{ scale: 0.6, opacity: 0 }}
				animate={{ scale: 1, opacity: 1 }}
				transition={{ type: "spring", stiffness: 280, damping: 20 }}
				className="flex size-20 items-center justify-center rounded-full bg-emerald-500/90 text-3xl"
			>
				✓
			</motion.div>
		);
	}
	if (phase === "error") {
		return (
			<div className="flex size-20 items-center justify-center rounded-full bg-red-500/80 text-3xl">
				✕
			</div>
		);
	}
	return <div className="size-20 rounded-full bg-white/15" />;
}
