import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";

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

// ---------------------------------------------------------------------------
// Lightweight markdown-to-HTML renderer
// ---------------------------------------------------------------------------

function renderMarkdown(md: string): string {
	// Escape HTML entities first
	let html = md
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// Fenced code blocks: ```lang\n...\n```
	html = html.replace(
		/```[\w]*\n([\s\S]*?)```/g,
		(_match, code) =>
			`<pre class="md-code-block"><code>${code.replace(/\n$/, "")}</code></pre>`,
	);

	// Split into lines for block-level processing, but preserve code blocks
	const codeBlockPlaceholders: string[] = [];
	html = html.replace(/<pre class="md-code-block">[\s\S]*?<\/pre>/g, (m) => {
		codeBlockPlaceholders.push(m);
		return `%%CODEBLOCK_${codeBlockPlaceholders.length - 1}%%`;
	});

	const lines = html.split("\n");
	const result: string[] = [];
	let inUl = false;
	let inOl = false;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// Check for code block placeholder
		const placeholderMatch = line.match(/^%%CODEBLOCK_(\d+)%%$/);
		if (placeholderMatch) {
			if (inUl) {
				result.push("</ul>");
				inUl = false;
			}
			if (inOl) {
				result.push("</ol>");
				inOl = false;
			}
			result.push(codeBlockPlaceholders[Number(placeholderMatch[1])]);
			continue;
		}

		// Apply inline formatting
		line = applyInlineFormatting(line);

		// Headers
		const h3 = line.match(/^###\s+(.*)/);
		if (h3) {
			closeList();
			result.push(`<h3 class="md-h3">${h3[1]}</h3>`);
			continue;
		}
		const h2 = line.match(/^##\s+(.*)/);
		if (h2) {
			closeList();
			result.push(`<h2 class="md-h2">${h2[1]}</h2>`);
			continue;
		}
		const h1 = line.match(/^#\s+(.*)/);
		if (h1) {
			closeList();
			result.push(`<h1 class="md-h1">${h1[1]}</h1>`);
			continue;
		}

		// Unordered list items
		const ul = line.match(/^[-*]\s+(.*)/);
		if (ul) {
			if (inOl) {
				result.push("</ol>");
				inOl = false;
			}
			if (!inUl) {
				result.push('<ul class="md-ul">');
				inUl = true;
			}
			result.push(`<li>${ul[1]}</li>`);
			continue;
		}

		// Ordered list items
		const ol = line.match(/^\d+\.\s+(.*)/);
		if (ol) {
			if (inUl) {
				result.push("</ul>");
				inUl = false;
			}
			if (!inOl) {
				result.push('<ol class="md-ol">');
				inOl = true;
			}
			result.push(`<li>${ol[1]}</li>`);
			continue;
		}

		// Close any open lists on non-list lines
		closeList();

		// Blank lines become spacing
		if (line.trim() === "") {
			result.push('<div class="md-spacer"></div>');
		} else {
			result.push(`<p class="md-p">${line}</p>`);
		}
	}

	closeList();
	return result.join("\n");

	function closeList() {
		if (inUl) {
			result.push("</ul>");
			inUl = false;
		}
		if (inOl) {
			result.push("</ol>");
			inOl = false;
		}
	}
}

function applyInlineFormatting(text: string): string {
	// Inline code (must come before bold/italic to avoid conflicts)
	text = text.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
	// Bold
	text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	// Italic (single * not preceded/followed by space for better accuracy)
	text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
	return text;
}

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
	const [editing, setEditing] = useState(false);
	const [editBody, setEditBody] = useState("");
	const [editingTitle, setEditingTitle] = useState(false);
	const [editTitle, setEditTitle] = useState("");
	const [colorPickerOpen, setColorPickerOpen] = useState(false);

	// Detect if this is a remote note window
	const windowLabel = getCurrentWindow().label;
	const isRemote = windowLabel.startsWith("remote-");
	const noteId = isRemote ? windowLabel.replace("remote-", "") : windowLabel;

	useEffect(() => {
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
	useEffect(() => {
		if (!note || isRemote) return;
		const win = getCurrentWindow();
		let timeout: ReturnType<typeof setTimeout>;
		const unlisten = win.onMoved((event) => {
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				invoke("update_note_position", {
					id: note.id,
					x: event.payload.x,
					y: event.payload.y,
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
		// Don't drag when clicking buttons or scrollable content
		if ((e.target as HTMLElement).closest("button")) return;
		getCurrentWindow().startDragging();
	}, []);

	const renderedBody = useMemo(
		() => (note ? renderMarkdown(note.body) : ""),
		[note?.body, note],
	);

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
				padding: "16px",
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

			{/* Title — double-click to edit (local only) */}
			{!isRemote && editingTitle ? (
				<input
					autoFocus
					value={editTitle}
					onChange={(e) => setEditTitle(e.target.value)}
					onBlur={() => {
						setEditingTitle(false);
						const newTitle = editTitle.trim() || undefined;
						if (newTitle !== note.title) {
							invoke<Note | null>("update_note_body", {
								id: note.id,
								body: note.body,
								title: newTitle ?? "",
							}).then((updated) => {
								if (updated) setNote(updated);
							});
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							(e.target as HTMLInputElement).blur();
						}
						if (e.key === "Escape") {
							setEditingTitle(false);
							setEditTitle(note.title ?? "");
						}
					}}
					onMouseDown={(e) => e.stopPropagation()}
					placeholder="Title"
					style={{
						fontWeight: 600,
						fontSize: "14px",
						marginBottom: "8px",
						paddingRight: "60px",
						lineHeight: 1.3,
						background: "rgba(0,0,0,0.04)",
						color: colors.text,
						border: "1px solid rgba(0,0,0,0.1)",
						borderRadius: "4px",
						padding: "4px 8px",
						outline: "none",
						width: "100%",
						boxSizing: "border-box",
						fontFamily: "inherit",
						cursor: "text",
					}}
				/>
			) : (
				<div
					onDoubleClick={
						isRemote
							? undefined
							: () => {
									setEditTitle(note.title ?? "");
									setEditingTitle(true);
								}
					}
					style={{
						fontWeight: 600,
						fontSize: note.title ? "14px" : "12px",
						marginBottom: "8px",
						paddingRight: isRemote ? "0" : "60px",
						lineHeight: 1.3,
						cursor: isRemote ? "default" : "text",
						opacity: note.title ? 1 : isRemote ? 0 : 0.35,
						display: isRemote && !note.title ? "none" : undefined,
					}}
				>
					{isRemote ? note.title : note.title || "Add title..."}
				</div>
			)}

			{/* Body — click to edit, blur to save (local only) */}
			{!isRemote && editing ? (
				<textarea
					autoFocus
					value={editBody}
					onChange={(e) => setEditBody(e.target.value)}
					onBlur={() => {
						setEditing(false);
						if (editBody !== note.body) {
							invoke<Note | null>("update_note_body", {
								id: note.id,
								body: editBody,
							}).then((updated) => {
								if (updated) setNote(updated);
							});
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setEditing(false);
							setEditBody(note.body);
						}
					}}
					onMouseDown={(e) => e.stopPropagation()}
					style={{
						flex: 1,
						fontSize: "13px",
						lineHeight: 1.5,
						fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
						background: "rgba(0,0,0,0.04)",
						color: colors.text,
						border: "1px solid rgba(0,0,0,0.1)",
						borderRadius: "4px",
						padding: "8px",
						resize: "none",
						outline: "none",
						cursor: "text",
						userSelect: "text",
					}}
				/>
			) : (
				<div
					className="md-body"
					onDoubleClick={
						isRemote
							? undefined
							: () => {
									setEditBody(note.body);
									setEditing(true);
								}
					}
					style={{
						flex: 1,
						fontSize: "13px",
						lineHeight: 1.5,
						overflowY: "auto",
						paddingRight: "4px",
						wordBreak: "break-word",
						cursor: isRemote ? "default" : "text",
					}}
					dangerouslySetInnerHTML={{
						__html: renderedBody,
					}}
				/>
			)}

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
