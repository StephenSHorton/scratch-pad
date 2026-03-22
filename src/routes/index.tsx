import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

function StickyNote() {
	const [note, setNote] = useState<Note | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		const win = getCurrentWindow();
		const noteId = win.label;
		invoke<Note | null>("get_note", { id: noteId }).then((n) => {
			if (n) setNote(n);
		});
	}, []);

	// Save position when window is moved
	useEffect(() => {
		if (!note) return;
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
	}, [note?.id]);

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
			}}
		>
			{/* Top-right controls */}
			<div
				style={{
					position: "absolute",
					top: "8px",
					right: "10px",
					display: "flex",
					alignItems: "center",
					gap: "4px",
				}}
			>
				{/* Color picker */}
				<button
					type="button"
					onClick={() => {
						const colorOrder: Note["color"][] = ["yellow", "pink", "blue", "green"];
						const idx = colorOrder.indexOf(note.color);
						const next = colorOrder[(idx + 1) % colorOrder.length];
						invoke<Note | null>("update_note_color", { id: note.id, color: next }).then(
							(updated) => {
								if (updated) setNote(updated);
							},
						);
					}}
					style={{
						background: "none",
						border: "none",
						cursor: "pointer",
						padding: "2px",
						opacity: 0.6,
						transition: "opacity 0.15s",
						display: "flex",
						alignItems: "center",
						gap: "2px",
					}}
					onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
					onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
				>
					{(["yellow", "pink", "blue", "green"] as const)
						.filter((c) => c !== note.color)
						.map((c) => (
							<span
								key={c}
								style={{
									display: "inline-block",
									width: "8px",
									height: "8px",
									borderRadius: "50%",
									background: NOTE_COLORS[c].bg,
									border: `1px solid ${NOTE_COLORS[c].dismiss}`,
								}}
							/>
						))}
				</button>

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

			{/* Title */}
			{note.title && (
				<div
					style={{
						fontWeight: 600,
						fontSize: "14px",
						marginBottom: "8px",
						paddingRight: "24px",
						lineHeight: 1.3,
					}}
				>
					{note.title}
				</div>
			)}

			{/* Body */}
			<div
				className="md-body"
				style={{
					flex: 1,
					fontSize: "13px",
					lineHeight: 1.5,
					overflowY: "auto",
					paddingRight: "4px",
					wordBreak: "break-word",
				}}
				dangerouslySetInnerHTML={{
					__html: renderedBody,
				}}
			/>

			{/* Timestamp */}
			<div
				style={{
					fontSize: "10px",
					opacity: 0.5,
					marginTop: "8px",
					textAlign: "right",
				}}
			>
				{timeAgo}
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
