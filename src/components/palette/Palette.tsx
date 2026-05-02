import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	listSnapshots,
	openMeetingWindow,
} from "@/lib/aizuchi/persistence";

interface Action {
	id: string;
	label: string;
	description: string;
}

const ACTIONS: Action[] = [
	{
		id: "aizuchi",
		label: "Start a meeting",
		description: "Open the Aizuchi mind-map window",
	},
	{
		id: "open_last_meeting",
		label: "Open last meeting",
		description:
			"Reopen the most recent saved meeting in archived (read-only) mode",
	},
	{
		id: "new_pad",
		label: "New scratch pad",
		description: "Create a blank sticky note",
	},
	{
		id: "organize",
		label: "Organize pads",
		description: "Auto-layout all open pads",
	},
	{
		id: "lobby",
		label: "Multiplayer…",
		description: "Open the room lobby",
	},
	{
		id: "show_logs",
		label: "Show logs",
		description: "Open the log viewer",
	},
	{
		id: "record_and_transcribe",
		label: "Record + transcribe (5s)",
		description:
			"Capture 5s of mic audio, run whisper (~39MB tiny.en model on first use), drop a sticky note",
	},
	{
		id: "start_live_capture",
		label: "Start live transcription",
		description:
			"Continuously transcribe mic input — watch chunks arrive in the recording window",
	},
];

function rank(query: string, action: Action): number {
	if (!query) return 1;
	const q = query.toLowerCase();
	const label = action.label.toLowerCase();
	const desc = action.description.toLowerCase();
	if (label.startsWith(q)) return 3;
	if (label.includes(q)) return 2;
	if (desc.includes(q)) return 1;
	return 0;
}

export function Palette() {
	const [query, setQuery] = useState("");
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [isOpen, setIsOpen] = useState(true);
	const inputRef = useRef<HTMLInputElement>(null);

	const beginClose = () => setIsOpen(false);

	const filtered = useMemo(() => {
		return ACTIONS.map((a) => ({ a, score: rank(query, a) }))
			.filter((x) => x.score > 0)
			.sort((x, y) => y.score - x.score)
			.map((x) => x.a);
	}, [query]);

	useEffect(() => {
		setSelectedIdx(0);
	}, [query]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Prevent scrollbar flash during the slide-up animation
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);

	useEffect(() => {
		const win = getCurrentWindow();
		const unlisten = win.onFocusChanged(({ payload: focused }) => {
			if (!focused) beginClose();
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, []);

	const runAction = async (id: string) => {
		if (id === "record_and_transcribe") {
			console.log("[audio] starting record + transcribe…");
			invoke<string>("record_and_transcribe")
				.then((text) => console.log("[audio] transcript:", text))
				.catch((err) => console.error("[audio] failed:", err));
			beginClose();
			return;
		}
		if (id === "start_live_capture") {
			console.log("[audio] starting live capture…");
			invoke("start_live_capture").catch((err) =>
				console.error("[audio] live capture failed:", err),
			);
			beginClose();
			return;
		}
		if (id === "open_last_meeting") {
			try {
				const meetings = await listSnapshots();
				const latest = meetings[0];
				if (!latest) {
					console.warn("[meeting] no saved meetings yet");
				} else {
					await openMeetingWindow(latest.id);
				}
			} catch (err) {
				console.error("[meeting] open last failed:", err);
			}
			beginClose();
			return;
		}
		await invoke("dispatch_action", { id }).catch(() => {});
		beginClose();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			beginClose();
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedIdx((i) => Math.max(i - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const action = filtered[selectedIdx];
			if (action) runAction(action.id);
		}
	};

	return (
		<AnimatePresence
			onExitComplete={() => {
				invoke("close_palette").catch(() => {});
			}}
		>
			{isOpen && (
				<motion.div
					key="palette"
					initial={{ opacity: 0, y: 12 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0, y: 12 }}
					transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
					className="flex h-screen w-screen flex-col overflow-hidden rounded-[14px] border border-white/10 bg-black/40 text-white shadow-2xl backdrop-blur-2xl"
				>
					<input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Type a command…"
					className="w-full border-b border-white/10 bg-transparent px-5 py-4 text-lg text-white placeholder:text-white/40 focus:outline-none"
					spellCheck={false}
					autoCorrect="off"
					autoCapitalize="off"
				/>
				<div className="flex-1 overflow-y-auto p-2">
					{filtered.length === 0 ? (
						<div className="px-4 py-8 text-center text-sm text-white/50">
							No commands match "{query}"
						</div>
					) : (
						filtered.map((action, i) => (
							<button
								key={action.id}
								type="button"
								onMouseEnter={() => setSelectedIdx(i)}
								onClick={() => runAction(action.id)}
								className={`flex w-full flex-col items-start rounded-md px-3 py-2 text-left transition-colors ${
									i === selectedIdx
										? "bg-white/15"
										: "hover:bg-white/10"
								}`}
							>
								<span className="text-sm font-medium text-white">
									{action.label}
								</span>
								<span className="text-xs text-white/55">
									{action.description}
								</span>
							</button>
						))
					)}
				</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
