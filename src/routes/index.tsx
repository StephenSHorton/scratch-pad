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

	// Lobby state
	const [roomCode, setRoomCode] = useState<string | null>(null);
	const [joinCode, setJoinCode] = useState("");
	const [peers, setPeers] = useState<{ node_id: string; name: string; addr: string; connected_at: string; last_seen: string }[]>([]);
	const [lobbyError, setLobbyError] = useState<string | null>(null);
	const [lobbyLoading, setLobbyLoading] = useState(false);
	const [lobbyInfo, setLobbyInfo] = useState<{ node_id: string; display_name: string } | null>(null);

	// Detect window type
	const windowLabel = getCurrentWindow().label;
	const isRemote = windowLabel.startsWith("remote-");
	const isLogs = windowLabel === "logs";
	const isLobby = windowLabel === "lobby";
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

	// Lobby: fetch info and poll peers
	useEffect(() => {
		if (!isLobby) return;
		invoke<{ node_id: string; display_name: string; ip: string; port: number; room_code: string }>("get_local_network_info")
			.then((info) => setLobbyInfo({ node_id: info.node_id, display_name: info.display_name }))
			.catch(() => {});
		const fetchPeers = () => {
			invoke<{ node_id: string; name: string; addr: string; connected_at: string; last_seen: string }[]>("get_peers")
				.then(setPeers)
				.catch(() => {});
		};
		fetchPeers();
		const interval = setInterval(fetchPeers, 2000);
		const unlistenConnect = listen<{ node_id: string; name: string }>("peer-connected", (event) => {
			fetchPeers();
		});
		const unlistenDisconnect = listen<{ node_id: string }>("peer-disconnected", () => {
			fetchPeers();
		});
		return () => {
			clearInterval(interval);
			unlistenConnect.then((fn) => fn());
			unlistenDisconnect.then((fn) => fn());
		};
	}, [isLobby]);

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
		if (isLogs || isLobby) return; // Skip note fetching for log viewer / lobby
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

	// Lobby rendering
	if (isLobby) {
		const handleHost = async () => {
			setLobbyError(null);
			try {
				const result = await invoke<{ code: string; ip: string; port: number }>("host_room");
				setRoomCode(result.code);
			} catch (e) {
				setLobbyError(String(e));
			}
		};

		const handleJoin = async () => {
			if (!joinCode.trim()) return;
			setLobbyError(null);
			setLobbyLoading(true);
			try {
				const result = await invoke<{ peer_name: string; peer_id: string }>("join_room", { code: joinCode.trim() });
				setJoinCode("");
				setLobbyLoading(false);
			} catch (e) {
				setLobbyError(String(e));
				setLobbyLoading(false);
			}
		};

		const handleDisconnect = async (nodeId: string) => {
			try {
				await invoke("disconnect_peer", { nodeId });
			} catch (e) {
				setLobbyError(String(e));
			}
		};

		const handleCopy = () => {
			if (roomCode) {
				navigator.clipboard.writeText(roomCode).catch(() => {});
			}
		};

		return (
			<div
				onMouseDown={handleMouseDown}
				style={{
					background: "#1e1e1e",
					color: "#d4d4d4",
					borderRadius: "8px",
					padding: "16px",
					height: "100vh",
					display: "flex",
					flexDirection: "column",
					boxShadow: "0 4px 24px rgba(0,0,0,0.3), 0 1.5px 6px rgba(0,0,0,0.15)",
					fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
					cursor: "grab",
					userSelect: "none",
					overflow: "hidden",
					gap: "12px",
				}}
			>
				{/* Header */}
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
					<div>
						<span style={{ fontSize: "13px", fontWeight: 700, color: "#e0e0e0" }}>Multiplayer</span>
						{lobbyInfo && (
							<span style={{ fontSize: "10px", color: "#666", marginLeft: "8px" }}>{lobbyInfo.display_name}</span>
						)}
					</div>
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

				{/* Error banner */}
				{lobbyError && (
					<div style={{
						background: "#3d1f1f",
						border: "1px solid #5c2e2e",
						borderRadius: "6px",
						padding: "8px 10px",
						fontSize: "11px",
						color: "#f48771",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
					}}>
						<span>{lobbyError}</span>
						<button
							type="button"
							onClick={() => setLobbyError(null)}
							style={{ background: "none", border: "none", color: "#f48771", cursor: "pointer", fontSize: "12px" }}
						>
							{"\u2715"}
						</button>
					</div>
				)}

				{/* Host Room */}
				<div style={{
					background: "#252526",
					borderRadius: "8px",
					padding: "12px",
					border: "1px solid #333",
				}}>
					<div style={{ fontSize: "11px", fontWeight: 600, color: "#7ec699", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
						Host a Room
					</div>
					{roomCode ? (
						<div>
							<div style={{
								fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
								fontSize: "20px",
								fontWeight: 700,
								color: "#e0e0e0",
								textAlign: "center",
								padding: "8px 0",
								letterSpacing: "2px",
							}}>
								{roomCode}
							</div>
							<div style={{ fontSize: "10px", color: "#666", textAlign: "center", marginBottom: "8px" }}>
								Share this code with your teammate
							</div>
							<div style={{ display: "flex", gap: "6px" }}>
								<button
									type="button"
									onClick={handleCopy}
									style={{
										flex: 1,
										background: "#333",
										border: "1px solid #444",
										color: "#d4d4d4",
										borderRadius: "5px",
										padding: "6px",
										fontSize: "11px",
										cursor: "pointer",
									}}
								>
									Copy Code
								</button>
								<button
									type="button"
									onClick={() => setRoomCode(null)}
									style={{
										flex: 1,
										background: "none",
										border: "1px solid #444",
										color: "#999",
										borderRadius: "5px",
										padding: "6px",
										fontSize: "11px",
										cursor: "pointer",
									}}
								>
									Hide
								</button>
							</div>
						</div>
					) : (
						<button
							type="button"
							onClick={handleHost}
							style={{
								width: "100%",
								background: "#2d6a4f",
								border: "none",
								color: "#e0e0e0",
								borderRadius: "5px",
								padding: "8px",
								fontSize: "12px",
								fontWeight: 600,
								cursor: "pointer",
							}}
							onMouseEnter={(e) => (e.currentTarget.style.background = "#3a8463")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "#2d6a4f")}
						>
							Create Room
						</button>
					)}
				</div>

				{/* Join Room */}
				<div style={{
					background: "#252526",
					borderRadius: "8px",
					padding: "12px",
					border: "1px solid #333",
				}}>
					<div style={{ fontSize: "11px", fontWeight: 600, color: "#569cd6", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
						Join a Room
					</div>
					<div style={{ display: "flex", gap: "6px" }}>
						<input
							type="text"
							value={joinCode}
							onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
							onKeyDown={(e) => { if (e.key === "Enter") handleJoin(); }}
							placeholder="XXXX-XXXX-XX"
							style={{
								flex: 1,
								background: "#1e1e1e",
								border: "1px solid #444",
								color: "#d4d4d4",
								borderRadius: "5px",
								padding: "7px 10px",
								fontSize: "13px",
								fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
								letterSpacing: "1px",
								outline: "none",
							}}
							onFocus={(e) => (e.currentTarget.style.borderColor = "#569cd6")}
							onBlur={(e) => (e.currentTarget.style.borderColor = "#444")}
						/>
						<button
							type="button"
							onClick={handleJoin}
							disabled={lobbyLoading || !joinCode.trim()}
							style={{
								background: lobbyLoading ? "#333" : "#1a4a7a",
								border: "none",
								color: "#e0e0e0",
								borderRadius: "5px",
								padding: "7px 14px",
								fontSize: "12px",
								fontWeight: 600,
								cursor: lobbyLoading ? "wait" : "pointer",
								opacity: !joinCode.trim() ? 0.5 : 1,
							}}
							onMouseEnter={(e) => { if (!lobbyLoading && joinCode.trim()) e.currentTarget.style.background = "#245d99"; }}
							onMouseLeave={(e) => { if (!lobbyLoading) e.currentTarget.style.background = "#1a4a7a"; }}
						>
							{lobbyLoading ? "..." : "Join"}
						</button>
					</div>
				</div>

				{/* Connected Peers */}
				<div style={{
					flex: 1,
					background: "#252526",
					borderRadius: "8px",
					padding: "12px",
					border: "1px solid #333",
					overflowY: "auto",
				}}>
					<div style={{ fontSize: "11px", fontWeight: 600, color: "#999", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
						Connected Peers ({peers.length})
					</div>
					{peers.length === 0 ? (
						<div style={{ fontSize: "11px", color: "#555", textAlign: "center", padding: "16px 0" }}>
							No peers connected
						</div>
					) : (
						<div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
							{peers.map((peer) => (
								<div
									key={peer.node_id}
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										padding: "6px 8px",
										background: "#1e1e1e",
										borderRadius: "5px",
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
										<div style={{
											width: "8px",
											height: "8px",
											borderRadius: "50%",
											background: senderColor(peer.node_id),
										}} />
										<span style={{ fontSize: "12px", color: "#d4d4d4" }}>{peer.name}</span>
										<span style={{
											fontSize: "9px",
											background: "#1a3a1a",
											color: "#7ec699",
											padding: "1px 5px",
											borderRadius: "3px",
										}}>
											connected
										</span>
									</div>
									<button
										type="button"
										onClick={() => handleDisconnect(peer.node_id)}
										style={{
											background: "none",
											border: "1px solid #444",
											color: "#999",
											borderRadius: "4px",
											padding: "2px 8px",
											fontSize: "10px",
											cursor: "pointer",
										}}
										onMouseEnter={(e) => {
											e.currentTarget.style.borderColor = "#f48771";
											e.currentTarget.style.color = "#f48771";
										}}
										onMouseLeave={(e) => {
											e.currentTarget.style.borderColor = "#444";
											e.currentTarget.style.color = "#999";
										}}
									>
										Disconnect
									</button>
								</div>
							))}
						</div>
					)}
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
				padding: "16px 10px 16px 4px",
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
