import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { NoteEditor } from "../lexical/NoteEditor";

// Note type
interface Note {
	id: string;
	title?: string;
	body: string;
	color: "yellow" | "pink" | "blue" | "green";
	createdAt: string;
	expiresAt?: string;
	position?: { x: number; y: number };
}

// Remote note from P2P peers
interface RemoteNote {
	id: string;
	sender: string;
	senderId: string;
	scope: string;
	intent: "decision" | "question" | "context" | "handoff" | "fyi";
	title: string | null;
	body: string;
	color: string;
	timestamp: number;
	ttl: number;
}

// Post-it color palette
const NOTE_COLORS = {
	yellow: { bg: "#FFF9C4", text: "#5D4037", dismiss: "#BFA76A" },
	pink: { bg: "#F8BBD0", text: "#4A1942", dismiss: "#C48B9F" },
	blue: { bg: "#BBDEFB", text: "#1A3A5C", dismiss: "#8BAAC4" },
	green: { bg: "#C8E6C9", text: "#1B5E20", dismiss: "#8FBA91" },
} as const;

export const Route = createFileRoute("/")({
	component: StickyNote,
});

// Intent badge color mapping
const INTENT_COLORS: Record<string, string> = {
	decision: "#5C6BC0",
	question: "#EF6C00",
	context: "#78909C",
	handoff: "#7E57C2",
	fyi: "#66BB6A",
};

// Deterministic color from sender ID
function senderColor(senderId: string): string {
	let hash = 0;
	for (let i = 0; i < senderId.length; i++) {
		hash = senderId.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash % 360);
	return `hsl(${hue}, 60%, 55%)`;
}

function StickyNote() {
	const [note, setNote] = useState<Note | null>(null);
	const [remoteData, setRemoteData] = useState<RemoteNote | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [colorPickerOpen, setColorPickerOpen] = useState(false);

	// Log viewer state
	const [logContent, setLogContent] = useState("");
	const [logFilter, setLogFilter] = useState<string | null>(null);

	// Highlight (emphasis) state — set by AI via MCP, cleared on user click
	const [highlightPattern, setHighlightPattern] = useState<string | null>(null);

	// Detect window type
	const windowLabel = getCurrentWindow().label;
	const isRemote = windowLabel.startsWith("remote-");
	const isLogs = windowLabel === "logs";
	const noteId = isRemote ? windowLabel.replace("remote-", "") : windowLabel;

	// Log viewer: poll for new content every 1.5s
	useEffect(() => {
		if (!isLogs) return;
		const fetchLogs = () => {
			invoke<string>("read_log_tail", { lines: 200 }).then(setLogContent);
		};
		fetchLogs();
		const interval = setInterval(fetchLogs, 1500);

		// Listen for filter updates from MCP
		const unlisten = listen<string>("log-filter", (event) => {
			setLogFilter(event.payload);
		});
		return () => {
			clearInterval(interval);
			unlisten.then((fn) => fn());
		};
	}, [isLogs]);

	// Listen for highlight events from MCP (local notes only)
	useEffect(() => {
		if (isLogs || isRemote) return;
		const unlisten = listen<string>("note-highlight", (event) => {
			setHighlightPattern(event.payload);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [isLogs, isRemote]);

	useEffect(() => {
		if (isLogs) return; // Skip note fetching for log viewer
		if (isRemote) {
			// Fetch remote note data from Tauri backend
			invoke<RemoteNote | null>("get_remote_note", { id: noteId }).then(
				(rn) => {
					if (rn) {
						setRemoteData(rn);
						// Convert to local Note shape for rendering
						const color = (
							["yellow", "pink", "blue", "green"].includes(rn.color)
								? rn.color
								: "yellow"
						) as Note["color"];
						setNote({
							id: rn.id,
							title: rn.title ?? undefined,
							body: rn.body,
							color,
							createdAt: new Date(rn.timestamp).toISOString(),
						});
					}
				},
			);
		} else {
			invoke<Note | null>("get_note", { id: noteId }).then((n) => {
				if (n) setNote(n);
			});

			// Listen for updates pushed from the backend (e.g. MCP server edits)
			const unlisten = listen<Note>("note-updated", (event) => {
				if (event.payload.id === noteId) {
					setNote(event.payload);
				}
			});
			return () => {
				unlisten.then((fn) => fn());
			};
		}
	}, [isRemote, noteId]);

	// Save position when window is moved (local notes only)
	// onMoved returns PhysicalPosition — convert to logical for consistent storage
	useEffect(() => {
		if (!note || isRemote) return;
		const win = getCurrentWindow();
		let timeout: ReturnType<typeof setTimeout>;
		const unlisten = win.onMoved(async (event) => {
			clearTimeout(timeout);
			const scaleFactor = await win.scaleFactor();
			timeout = setTimeout(() => {
				invoke("update_note_position", {
					id: note.id,
					x: event.payload.x / scaleFactor,
					y: event.payload.y / scaleFactor,
				});
			}, 500); // debounce
		});
		return () => {
			clearTimeout(timeout);
			unlisten.then((fn) => fn());
		};
	}, [note?.id, isRemote, note]);

	// Programmatic drag — more reliable than data-tauri-drag-region on macOS transparent windows
	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		const target = e.target as HTMLElement;
		// Don't drag when clicking buttons, the editable content, or input fields
		if (target.closest("button")) return;
		if (target.closest(".lexical-content-editable")) return;
		if (target.closest("input, textarea")) return;
		getCurrentWindow().startDragging();
	}, []);

	// Dismiss highlight — clears local state AND removes from highlights.json
	const dismissHighlight = useCallback(() => {
		setHighlightPattern(null);
		if (note) {
			invoke("clear_note_highlight", { id: note.id }).catch(() => {});
		}
	}, [note]);

	// Log viewer rendering
	if (isLogs) {
		return (
			<div
				onMouseDown={handleMouseDown}
				style={{
					background: "#1e1e1e",
					color: "#d4d4d4",
					borderRadius: "8px",
					padding: "12px",
					height: "100vh",
					display: "flex",
					flexDirection: "column",
					boxShadow: "0 4px 24px rgba(0,0,0,0.3), 0 1.5px 6px rgba(0,0,0,0.15)",
					fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
					cursor: "grab",
					userSelect: "none",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: "8px",
					}}
				>
					<span style={{ fontSize: "11px", fontWeight: 600, color: "#7ec699", textTransform: "uppercase", letterSpacing: "0.5px" }}>
						Live Logs
					</span>
					<button
						type="button"
						onClick={() => getCurrentWindow().close()}
						style={{
							background: "none",
							border: "none",
							color: "#666",
							fontSize: "16px",
							cursor: "pointer",
							padding: "2px 4px",
							lineHeight: 1,
						}}
						onMouseEnter={(e) => (e.currentTarget.style.color = "#d4d4d4")}
						onMouseLeave={(e) => (e.currentTarget.style.color = "#666")}
					>
						{"\u2715"}
					</button>
				</div>
				{logFilter && (
					<div
						style={{
							fontSize: "9px",
							color: "#7ec699",
							marginBottom: "4px",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
						}}
					>
						<span>filter: "{logFilter}"</span>
						<button
							type="button"
							onClick={() => setLogFilter(null)}
							style={{
								background: "none",
								border: "none",
								color: "#666",
								fontSize: "10px",
								cursor: "pointer",
								padding: "0 4px",
							}}
						>
							clear
						</button>
					</div>
				)}
				<div
					ref={(el) => {
						if (el) el.scrollTop = el.scrollHeight;
					}}
					style={{
						flex: 1,
						fontSize: "10.5px",
						lineHeight: 1.6,
						overflowY: "auto",
						whiteSpace: "pre-wrap",
						wordBreak: "break-all",
						color: "#b5b5b5",
					}}
				>
					{logContent
						.split("\n")
						.filter((line) => !logFilter || line.toLowerCase().includes(logFilter.toLowerCase()))
						.map((line, i) => (
						<div
							key={i}
							style={{
								padding: "1px 0",
								color: line.includes("error") || line.includes("Error")
									? "#f48771"
									: line.includes("[network")
										? "#569cd6"
										: line.includes("Creating window")
											? "#7ec699"
											: "#b5b5b5",
							}}
						>
							{line}
						</div>
					))}
				</div>
			</div>
		);
	}

	if (!note) return null;

	const colors = NOTE_COLORS[note.color] || NOTE_COLORS.yellow;
	const timeAgo = getRelativeTime(note.createdAt);

	return (
		<div
			onMouseDown={handleMouseDown}
			style={{
				background: colors.bg,
				color: colors.text,
				borderRadius: "8px",
				padding: "16px 10px",
				height: "100vh",
				display: "flex",
				flexDirection: "column",
				boxShadow: "0 4px 24px rgba(0,0,0,0.18), 0 1.5px 6px rgba(0,0,0,0.10)",
				fontFamily: "'SF Pro Text', -apple-system, system-ui, sans-serif",
				cursor: "grab",
				userSelect: "none",
				overflow: "hidden",
				position: "relative",
				...(isRemote && remoteData
					? { borderLeft: `3px solid ${senderColor(remoteData.senderId)}` }
					: {}),
			}}
		>
			{/* Top bar — remote: sender/intent badges, local: color picker/delete */}
			{isRemote && remoteData ? (
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						padding: "0 0 4px",
						zIndex: 20,
					}}
				>
					{/* Sender badge */}
					<span
						className="remote-sender-badge"
						style={{
							fontSize: "10px",
							opacity: 0.5,
							fontWeight: 500,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							maxWidth: "120px",
						}}
					>
						from: {remoteData.sender}
					</span>
					<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
						{/* Intent badge */}
						<span
							className="remote-intent-badge"
							style={{
								fontSize: "9px",
								padding: "1px 6px",
								borderRadius: "3px",
								color: "white",
								fontWeight: 600,
								textTransform: "uppercase",
								letterSpacing: "0.5px",
								backgroundColor: INTENT_COLORS[remoteData.intent] ?? "#78909C",
							}}
						>
							{remoteData.intent}
						</span>
						{/* Dismiss button — just closes the window */}
						<button
							type="button"
							onClick={async () => {
								getCurrentWindow().close();
							}}
							style={{
								background: "none",
								border: "none",
								color: colors.dismiss,
								fontSize: "16px",
								cursor: "pointer",
								lineHeight: 1,
								padding: "2px 4px",
								borderRadius: "4px",
								opacity: 0.7,
								transition: "opacity 0.15s",
							}}
							onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
							onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
						>
							{"\u2715"}
						</button>
					</div>
				</div>
			) : (
				<div
					style={{
						position: "absolute",
						top: "8px",
						right: "10px",
						display: "flex",
						alignItems: "center",
						gap: "4px",
						zIndex: 20,
					}}
				>
					{/* Color picker — single dot that expands to show all colors */}
					<div
						style={{
							position: "relative",
							display: "flex",
							alignItems: "center",
						}}
					>
						<button
							type="button"
							onClick={() => setColorPickerOpen(!colorPickerOpen)}
							onBlur={() => setTimeout(() => setColorPickerOpen(false), 150)}
							style={{
								background: NOTE_COLORS[note.color].bg,
								border: `1.5px solid ${NOTE_COLORS[note.color].dismiss}`,
								width: "12px",
								height: "12px",
								borderRadius: "50%",
								cursor: "pointer",
								padding: 0,
								opacity: 0.8,
								transition: "opacity 0.15s",
							}}
							onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
							onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.8")}
						/>
						{colorPickerOpen && (
							<div
								style={{
									position: "absolute",
									top: "100%",
									right: 0,
									marginTop: "4px",
									background: "rgba(255,255,255,0.95)",
									borderRadius: "8px",
									padding: "6px",
									display: "flex",
									gap: "5px",
									boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
									zIndex: 10,
								}}
							>
								{(["yellow", "pink", "blue", "green"] as const).map((c) => (
									<button
										key={c}
										type="button"
										onClick={() => {
											if (c !== note.color) {
												invoke<Note | null>("update_note_color", {
													id: note.id,
													color: c,
												}).then((updated) => {
													if (updated) setNote(updated);
												});
											}
											setColorPickerOpen(false);
										}}
										style={{
											background: NOTE_COLORS[c].bg,
											border:
												c === note.color
													? `2px solid ${NOTE_COLORS[c].text}`
													: `1.5px solid ${NOTE_COLORS[c].dismiss}`,
											width: "18px",
											height: "18px",
											borderRadius: "50%",
											cursor: "pointer",
											padding: 0,
											transition: "transform 0.1s",
										}}
										onMouseEnter={(e) =>
											(e.currentTarget.style.transform = "scale(1.2)")
										}
										onMouseLeave={(e) =>
											(e.currentTarget.style.transform = "scale(1)")
										}
									/>
								))}
							</div>
						)}
					</div>

					{/* Delete button — two-step: click once to confirm, click again to delete */}
					<button
						type="button"
						onClick={() => {
							if (confirmDelete) {
								invoke("dismiss_note", { id: note.id });
							} else {
								setConfirmDelete(true);
							}
						}}
						onBlur={() => setConfirmDelete(false)}
						style={{
							background: confirmDelete ? "rgba(220,38,38,0.15)" : "none",
							border: "none",
							color: confirmDelete ? "#dc2626" : colors.dismiss,
							fontSize: confirmDelete ? "11px" : "18px",
							cursor: "pointer",
							lineHeight: 1,
							padding: confirmDelete ? "3px 6px" : "2px 4px",
							borderRadius: "4px",
							opacity: confirmDelete ? 1 : 0.7,
							transition: "all 0.15s",
							whiteSpace: "nowrap",
						}}
						onMouseEnter={(e) => {
							if (!confirmDelete) e.currentTarget.style.opacity = "1";
						}}
						onMouseLeave={(e) => {
							if (!confirmDelete) e.currentTarget.style.opacity = "0.7";
						}}
					>
						{confirmDelete ? "Delete?" : "\u2715"}
					</button>
				</div>
			)}

			{/* Title — always-present block-style input. Click to edit, Enter focuses body. */}
			{isRemote ? (
				note.title ? (
					<div
						style={{
							fontWeight: 600,
							fontSize: "14px",
							marginBottom: "4px",
							paddingLeft: "16px",
							paddingRight: "16px",
							marginLeft: "-6px",
							marginRight: "50px",
							lineHeight: 1.3,
							cursor: "grab",
						}}
					>
						{note.title}
					</div>
				) : null
			) : (
				<input
					className="note-title-block"
					defaultValue={note.title ?? ""}
					placeholder="Add title..."
					onMouseDown={(e) => e.stopPropagation()}
					onBlur={(e) => {
						const newTitle = e.target.value.trim();
						if (newTitle !== (note.title ?? "")) {
							invoke<Note | null>("update_note_body", {
								id: note.id,
								body: note.body,
								title: newTitle,
							}).then((updated) => {
								if (updated) setNote(updated);
							});
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							// Move focus to the body editor
							const editable = document.querySelector(
								".lexical-content-editable",
							);
							if (editable instanceof HTMLElement) {
								editable.focus();
							}
						}
						if (e.key === "Escape") {
							(e.target as HTMLInputElement).blur();
						}
					}}
					style={{
						fontWeight: 600,
						fontSize: "14px",
						marginBottom: "4px",
						lineHeight: 1.3,
						background: "transparent",
						color: colors.text,
						border: "none",
						outline: "none",
						boxSizing: "border-box",
						fontFamily: "inherit",
						cursor: "text",
					}}
				/>
			)}

			{/* Body — Lexical editor; click any block to start editing */}
			<div
				style={{
					flex: 1,
					position: "relative",
					overflow: "hidden",
					display: "flex",
					flexDirection: "column",
				}}
			>
				<NoteEditor
					body={note.body}
					editable={!isRemote}
					textColor={colors.text}
					highlightPattern={highlightPattern}
					onDismissHighlight={dismissHighlight}
					onChange={(newBody) => {
						if (newBody !== note.body) {
							invoke<Note | null>("update_note_body", {
								id: note.id,
								body: newBody,
							}).then((updated) => {
								if (updated) setNote(updated);
							});
						}
					}}
				/>
			</div>

			{/* Timestamp / attribution */}
			<div
				style={{
					fontSize: "10px",
					opacity: 0.5,
					marginTop: "8px",
					textAlign: "right",
				}}
			>
				{isRemote && remoteData ? `from ${remoteData.sender}` : timeAgo}
			</div>
		</div>
	);
}

function getRelativeTime(isoString: string): string {
	const now = Date.now();
	const then = new Date(isoString).getTime();
	const diffMs = now - then;
	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}
