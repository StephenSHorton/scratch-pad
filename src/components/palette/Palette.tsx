import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	deleteSnapshot,
	listSnapshots,
	type MeetingMeta,
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
		id: "browse_meetings",
		label: "Browse meetings…",
		description: "Search every saved meeting; open or delete from the palette",
	},
	{
		id: "import_meeting",
		label: "Import meeting…",
		description:
			"Process a transcript or recording (.txt / .md / .json / .wav / .mp3 / .m4a / .flac / .mp4 / .mov) as a meeting",
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
		id: "show_hidden_pads",
		label: "Show hidden pads",
		description: "Reopen any pads that were closed (un-hide all)",
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

function formatDate(ts: number): string {
	if (!ts) return "—";
	const d = new Date(ts);
	return d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function meetingDisplayName(m: MeetingMeta): string {
	// Names land in AIZ-16 — fall back to a short id prefix until then.
	const maybeName = (m as { name?: string }).name;
	if (maybeName && maybeName.trim().length > 0) return maybeName;
	const id = m.id ?? "";
	if (id.startsWith("meeting-")) {
		const rest = id.slice("meeting-".length);
		return `Meeting ${rest.slice(0, 8)}`;
	}
	return id.slice(0, 16) || "Untitled meeting";
}

function meetingFilterHaystack(m: MeetingMeta): string {
	const name = meetingDisplayName(m);
	const date = formatDate(m.endedAt || m.startedAt);
	return `${name} ${m.id} ${date}`.toLowerCase();
}

function formatDuration(ms: number): string {
	if (!ms || ms < 0) return "0s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

const RECENT_LIMIT = 3;

export function Palette() {
	const [view, setView] = useState<"main" | "browse">("main");
	const [query, setQuery] = useState("");
	const [browseQuery, setBrowseQuery] = useState("");
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [browseSelectedIdx, setBrowseSelectedIdx] = useState(0);
	const [isOpen, setIsOpen] = useState(true);
	const [meetings, setMeetings] = useState<MeetingMeta[] | null>(null);
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
		null,
	);
	// AIZ-31 — when set, the palette renders a "transcribing…" card instead
	// of the usual command list, and the focus-blur auto-close is suppressed
	// so the file picker / long-running whisper run can't dismiss it midway.
	const [importingFile, setImportingFile] = useState<string | null>(null);
	const importingRef = useRef(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const browseInputRef = useRef<HTMLInputElement>(null);
	const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const beginClose = () => setIsOpen(false);

	const refreshMeetings = useCallback(async () => {
		try {
			const list = await listSnapshots();
			setMeetings(list);
		} catch (err) {
			console.error("[meeting] list failed:", err);
			setMeetings([]);
		}
	}, []);

	// Lazy-load meetings the first time the palette opens, so the "Recent
	// meetings" main-view section reflects the current on-disk state.
	useEffect(() => {
		refreshMeetings();
	}, [refreshMeetings]);

	const recentMeetings = useMemo(() => {
		return (meetings ?? []).slice(0, RECENT_LIMIT);
	}, [meetings]);

	const filteredActions = useMemo(() => {
		return ACTIONS.map((a) => ({ a, score: rank(query, a) }))
			.filter((x) => x.score > 0)
			.sort((x, y) => y.score - x.score)
			.map((x) => x.a);
	}, [query]);

	// Main view items: actions first, then recent meetings (when no query).
	const mainItems = useMemo<
		Array<
			| { kind: "action"; action: Action }
			| { kind: "recent"; meeting: MeetingMeta }
		>
	>(() => {
		const items: Array<
			| { kind: "action"; action: Action }
			| { kind: "recent"; meeting: MeetingMeta }
		> = filteredActions.map((action) => ({ kind: "action", action }));
		// Only show the recent section when there's no filter query.
		if (!query && recentMeetings.length > 0) {
			for (const m of recentMeetings)
				items.push({ kind: "recent", meeting: m });
		}
		return items;
	}, [filteredActions, recentMeetings, query]);

	const filteredMeetings = useMemo(() => {
		const list = meetings ?? [];
		const q = browseQuery.trim().toLowerCase();
		if (!q) return list;
		return list.filter((m) => meetingFilterHaystack(m).includes(q));
	}, [meetings, browseQuery]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: state setters are stable; we only want this to run when the search query changes
	useEffect(() => {
		setSelectedIdx(0);
	}, [query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: state setters are stable; we only want this to run when the search query changes
	useEffect(() => {
		setBrowseSelectedIdx(0);
		setConfirmingDeleteId(null);
	}, [browseQuery]);

	useEffect(() => {
		if (view === "main") {
			inputRef.current?.focus();
		} else {
			browseInputRef.current?.focus();
		}
	}, [view]);

	// Prevent scrollbar flash during the slide-up animation
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: beginClose only calls the stable setIsOpen setter; re-subscribing on every render would needlessly tear down the focus listener
	useEffect(() => {
		const win = getCurrentWindow();
		const unlisten = win.onFocusChanged(({ payload: focused }) => {
			// While an import is in flight (file picker open OR whisper running),
			// keep the palette visible so the user can see the transcribing card.
			if (!focused && !importingRef.current) beginClose();
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, []);

	useEffect(() => {
		return () => {
			if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
		};
	}, []);

	const openMeeting = async (id: string) => {
		try {
			await openMeetingWindow(id);
		} catch (err) {
			console.error("[meeting] open failed:", err);
		}
		beginClose();
	};

	const handleDeleteClick = (id: string) => {
		if (confirmingDeleteId === id) {
			// Second click within the timeout — actually delete.
			if (confirmTimerRef.current) {
				clearTimeout(confirmTimerRef.current);
				confirmTimerRef.current = null;
			}
			setConfirmingDeleteId(null);
			deleteSnapshot(id)
				.then(() => refreshMeetings())
				.catch((err) => console.error("[meeting] delete failed:", err));
			return;
		}
		// First click — arm confirm. Auto-revert after 2s.
		setConfirmingDeleteId(id);
		if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
		confirmTimerRef.current = setTimeout(() => {
			setConfirmingDeleteId((current) => (current === id ? null : current));
			confirmTimerRef.current = null;
		}, 2000);
	};

	const runAction = async (id: string) => {
		if (id === "browse_meetings") {
			setView("browse");
			refreshMeetings();
			return;
		}
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
		if (id === "import_meeting") {
			// AIZ-31 — keep the palette open during the file picker and the
			// subsequent (potentially multi-minute) whisper run so the user
			// has a visible "transcribing…" indicator. Suppress focus-blur
			// auto-close while the import is in flight.
			const audioVideoExts = ["wav", "mp3", "m4a", "flac", "mp4", "mov"];
			importingRef.current = true;
			openDialog({
				multiple: false,
				directory: false,
				title: "Import meeting (transcript or recording)",
				filters: [
					{
						name: "Transcript or recording",
						extensions: ["txt", "md", "json", ...audioVideoExts],
					},
				],
			})
				.then((selected) => {
					if (typeof selected !== "string") {
						// Cancelled — drop the suppression and dismiss.
						importingRef.current = false;
						beginClose();
						return undefined;
					}
					const lower = selected.toLowerCase();
					const isAudioVideo = audioVideoExts.some((ext) =>
						lower.endsWith(`.${ext}`),
					);
					const filename =
						selected.split(/[/\\]/).pop() ?? selected;
					if (isAudioVideo) setImportingFile(filename);
					const command = isAudioVideo
						? "import_audio_meeting_from_path"
						: "import_meeting_from_path";
					return invoke<{
						id: string;
						chunkCount: number;
						sourceFile: string;
					}>(command, { path: selected });
				})
				.then((result) => {
					if (result) {
						console.log(
							`[meeting-import] staged ${result.chunkCount} chunk(s) from ${result.sourceFile} as ${result.id}`,
						);
					}
				})
				.catch((err) => {
					console.error("[meeting-import] failed:", err);
				})
				.finally(() => {
					importingRef.current = false;
					setImportingFile(null);
					beginClose();
				});
			return;
		}
		if (id === "open_last_meeting") {
			try {
				const list = meetings ?? (await listSnapshots());
				const latest = list[0];
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

	const onMainKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			beginClose();
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelectedIdx((i) => Math.min(i + 1, Math.max(mainItems.length - 1, 0)));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelectedIdx((i) => Math.max(i - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const item = mainItems[selectedIdx];
			if (!item) return;
			if (item.kind === "action") {
				runAction(item.action.id);
			} else {
				openMeeting(item.meeting.id);
			}
		}
	};

	const onBrowseKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			// Esc from browse returns to main, not close.
			setView("main");
			setBrowseQuery("");
			setConfirmingDeleteId(null);
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setBrowseSelectedIdx((i) =>
				Math.min(i + 1, Math.max(filteredMeetings.length - 1, 0)),
			);
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setBrowseSelectedIdx((i) => Math.max(i - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const m = filteredMeetings[browseSelectedIdx];
			if (m) openMeeting(m.id);
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
					{importingFile ? (
						<div className="flex h-full w-full flex-col items-center justify-center px-8 py-10 text-center">
							<div
								className="mb-5 h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white/80"
								aria-hidden="true"
							/>
							<div className="text-base text-white/90">
								Transcribing {importingFile}…
							</div>
							<div className="mt-2 text-sm text-white/50">
								Running whisper locally. This can take a few minutes for long
								recordings; the meeting window will open when it's done.
							</div>
						</div>
					) : view === "main" ? (
						<>
							<input
								ref={inputRef}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={onMainKeyDown}
								placeholder="Type a command…"
								className="w-full border-b border-white/10 bg-transparent px-5 py-4 text-lg text-white placeholder:text-white/40 focus:outline-none"
								spellCheck={false}
								autoCorrect="off"
								autoCapitalize="off"
							/>
							<div className="flex-1 overflow-y-auto p-2">
								{mainItems.length === 0 ? (
									<div className="px-4 py-8 text-center text-sm text-white/50">
										No commands match "{query}"
									</div>
								) : (
									(() => {
										// Render items, inserting a "Recent meetings" header
										// before the first recent item.
										const out: React.ReactNode[] = [];
										let recentHeaderRendered = false;
										mainItems.forEach((item, i) => {
											if (item.kind === "recent" && !recentHeaderRendered) {
												recentHeaderRendered = true;
												out.push(
													<div
														key="recent-header"
														className="mt-2 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40"
													>
														Recent meetings
													</div>,
												);
											}
											if (item.kind === "action") {
												out.push(
													<button
														key={`action-${item.action.id}`}
														type="button"
														onMouseEnter={() => setSelectedIdx(i)}
														onClick={() => runAction(item.action.id)}
														className={`flex w-full flex-col items-start rounded-md px-3 py-2 text-left transition-colors ${
															i === selectedIdx
																? "bg-white/15"
																: "hover:bg-white/10"
														}`}
													>
														<span className="text-sm font-medium text-white">
															{item.action.label}
														</span>
														<span className="text-xs text-white/55">
															{item.action.description}
														</span>
													</button>,
												);
											} else {
												const m = item.meeting;
												out.push(
													<button
														key={`recent-${m.id}`}
														type="button"
														onMouseEnter={() => setSelectedIdx(i)}
														onClick={() => openMeeting(m.id)}
														className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors ${
															i === selectedIdx
																? "bg-white/15"
																: "hover:bg-white/10"
														}`}
													>
														<div className="flex min-w-0 flex-col">
															<span className="truncate text-sm font-medium text-white">
																{meetingDisplayName(m)}
															</span>
															<span className="text-xs text-white/55">
																{formatDate(m.endedAt || m.startedAt)} ·{" "}
																{m.nodeCount} nodes ·{" "}
																{formatDuration(m.transcriptDurationMs)}
															</span>
														</div>
														<span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/70">
															{m.mode}
														</span>
													</button>,
												);
											}
										});
										return out;
									})()
								)}
							</div>
						</>
					) : (
						<>
							<div className="flex items-center gap-2 border-b border-white/10 px-3">
								<button
									type="button"
									onClick={() => {
										setView("main");
										setBrowseQuery("");
										setConfirmingDeleteId(null);
									}}
									className="rounded px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white/90"
									aria-label="Back to main palette"
								>
									‹ Back
								</button>
								<input
									ref={browseInputRef}
									value={browseQuery}
									onChange={(e) => setBrowseQuery(e.target.value)}
									onKeyDown={onBrowseKeyDown}
									placeholder="Search meetings by name or date…"
									className="flex-1 bg-transparent py-4 text-lg text-white placeholder:text-white/40 focus:outline-none"
									spellCheck={false}
									autoCorrect="off"
									autoCapitalize="off"
								/>
							</div>
							<div className="flex-1 overflow-y-auto p-2">
								{meetings === null ? (
									<div className="px-4 py-8 text-center text-sm text-white/50">
										Loading meetings…
									</div>
								) : filteredMeetings.length === 0 ? (
									<div className="px-4 py-8 text-center text-sm text-white/50">
										{(meetings ?? []).length === 0
											? "No saved meetings yet"
											: `No meetings match "${browseQuery}"`}
									</div>
								) : (
									filteredMeetings.map((m, i) => {
										const isSelected = i === browseSelectedIdx;
										const isConfirming = confirmingDeleteId === m.id;
										return (
											// biome-ignore lint/a11y/useKeyWithClickEvents: row keyboard nav handled at search-input level (Enter opens, ArrowUp/Down moves selection)
											// biome-ignore lint/a11y/noStaticElementInteractions: row contains a delete button; using a <button> would create nested-button HTML
											<div
												key={m.id}
												onMouseEnter={() => setBrowseSelectedIdx(i)}
												onClick={(e) => {
													// Avoid hijacking when the click came from the trash button.
													if (
														e.target instanceof HTMLElement &&
														e.target.closest("[data-row-delete]")
													) {
														return;
													}
													openMeeting(m.id);
												}}
												className={`group flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors ${
													isConfirming
														? "bg-red-500/15 ring-1 ring-red-500/40"
														: isSelected
															? "bg-white/15"
															: "hover:bg-white/10"
												}`}
											>
												<div className="flex min-w-0 flex-1 flex-col">
													<div className="flex items-center gap-2">
														<span className="truncate text-sm font-medium text-white">
															{meetingDisplayName(m)}
														</span>
														<span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/70">
															{m.mode}
														</span>
													</div>
													<span className="truncate text-xs text-white/55">
														{formatDate(m.endedAt || m.startedAt)} ·{" "}
														{m.nodeCount} nodes · {m.thoughtCount} thoughts ·{" "}
														{formatDuration(m.transcriptDurationMs)}
													</span>
												</div>
												{isConfirming ? (
													<button
														type="button"
														data-row-delete
														onClick={(e) => {
															e.stopPropagation();
															handleDeleteClick(m.id);
														}}
														className="rounded border border-red-500/40 bg-red-500/20 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-500/30"
													>
														Click again to delete
													</button>
												) : (
													<button
														type="button"
														data-row-delete
														aria-label={`Delete meeting ${meetingDisplayName(m)}`}
														onClick={(e) => {
															e.stopPropagation();
															handleDeleteClick(m.id);
														}}
														className="rounded p-1.5 text-white/40 opacity-0 transition-opacity hover:bg-white/10 hover:text-red-300 group-hover:opacity-100 focus:opacity-100"
													>
														<Trash2 className="h-4 w-4" />
													</button>
												)}
											</div>
										);
									})
								)}
							</div>
						</>
					)}
				</motion.div>
			)}
		</AnimatePresence>
	);
}
