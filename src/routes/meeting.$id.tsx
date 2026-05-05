import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type PanelImperativeHandle,
	Group as ResizeGroup,
	Panel as ResizePanel,
	Separator as ResizeSeparator,
} from "react-resizable-panels";
import { LiveTranscript } from "@/components/aizuchi/LiveTranscript";
import { MeetingCanvas } from "@/components/aizuchi/MeetingCanvas";
import { MeetingOutline } from "@/components/aizuchi/MeetingOutline";
import { MeetingStatusPanel } from "@/components/aizuchi/MeetingStatusPanel";
import { useCommandPaletteHotkey } from "@/hooks/useCommandPaletteHotkey";
import { useForceLayout } from "@/hooks/useForceLayout";
import { useMeetingDebugSnapshot } from "@/hooks/useMeetingDebugSnapshot";
import { useMeetingSession } from "@/hooks/useMeetingSession";
import type { ExtractionMode, MeetingSource } from "@/lib/aizuchi/persistence";
import type {
	Edge as AzEdge,
	Node as AzNode,
	TranscriptChunk,
} from "@/lib/aizuchi/schemas";

// Drag the outline below this percentage and it snaps closed on release.
const OUTLINE_COLLAPSE_THRESHOLD = 20;

function MeetingPrototype() {
	useCommandPaletteHotkey();
	const { id } = Route.useParams();
	const session = useMeetingSession(id);

	const outlinePanelRef = useRef<PanelImperativeHandle>(null);
	const groupWrapperRef = useRef<HTMLDivElement>(null);
	const handleRef = useRef<HTMLDivElement>(null);
	const isDraggingRef = useRef(false);

	const isInHandle = (x: number, y: number) => {
		const r = handleRef.current?.getBoundingClientRect();
		if (!r) return false;
		return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
	};

	const handleOutlineResize = (size: { asPercentage: number }) => {
		if (!isDraggingRef.current) return;
		const wrapper = groupWrapperRef.current;
		if (!wrapper) return;
		const willClose =
			size.asPercentage > 0 && size.asPercentage < OUTLINE_COLLAPSE_THRESHOLD;
		wrapper.classList.toggle("aiz-will-close", willClose);
	};

	// isInHandle reads only from refs; rebinding the listener on every
	// render would churn document-level handlers without changing behavior.
	// biome-ignore lint/correctness/useExhaustiveDependencies: stable refs only
	useEffect(() => {
		// Window-level capture fires before the lib's document-level
		// capture handler and before the browser's default selection
		// logic. Engaging drag-state here (instead of in bubble phase)
		// means user-select:none is in place before the resize panels'
		// box-select or text selection can paint a frame.
		const onWindowDownCapture = (e: PointerEvent) => {
			const wrapper = groupWrapperRef.current;
			if (!wrapper) return;
			const target = e.target as Element | null;
			if (!target || !wrapper.contains(target)) return;

			if (isInHandle(e.clientX, e.clientY)) {
				isDraggingRef.current = true;
				wrapper.classList.add("aiz-resizing");
				document.body.style.userSelect = "none";
				window.getSelection()?.removeAllRanges();
				// `inert` fully disables interaction inside the resize panels
				// during a drag — stronger than pointer-events:none, so
				// nothing inside the panels intercepts the gesture.
				for (const el of wrapper.querySelectorAll("[data-panel]")) {
					el.setAttribute("inert", "");
				}
				return;
			}

			const sep = wrapper.querySelector(
				"[data-separator]",
			) as HTMLElement | null;
			if (!sep) return;
			const sr = sep.getBoundingClientRect();
			// Match resizeTargetMinimumSize.fine (24px) — 12px each side.
			const inHitZone =
				e.clientX >= sr.left - 12 &&
				e.clientX <= sr.right + 12 &&
				e.clientY >= sr.top &&
				e.clientY <= sr.bottom;
			if (inHitZone) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		window.addEventListener("pointerdown", onWindowDownCapture, true);

		const onSelectStart = (e: Event) => {
			if (isDraggingRef.current) e.preventDefault();
		};
		document.addEventListener("selectstart", onSelectStart);
		const onUp = () => {
			if (!isDraggingRef.current) return;
			isDraggingRef.current = false;
			document.body.style.userSelect = "";
			const wrapper = groupWrapperRef.current;
			wrapper?.classList.remove("aiz-resizing", "aiz-will-close");
			if (wrapper) {
				for (const el of wrapper.querySelectorAll("[data-panel]")) {
					el.removeAttribute("inert");
				}
			}
			const size = outlinePanelRef.current?.getSize();
			if (
				!size ||
				size.asPercentage === 0 ||
				size.asPercentage >= OUTLINE_COLLAPSE_THRESHOLD
			) {
				return;
			}
			if (!wrapper) return;
			wrapper.classList.add("aiz-snapping");
			void wrapper.offsetWidth;
			outlinePanelRef.current?.collapse();
			window.setTimeout(() => {
				wrapper.classList.remove("aiz-snapping");
			}, 400);
		};
		document.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointerdown", onWindowDownCapture, true);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("selectstart", onSelectStart);
		};
	}, []);

	// AIZ-20 — IPC handshake for `meeting start` and `meeting stop`.
	// The CLI / MCP triggers a meeting via `POST /v1/meetings` which opens
	// this route with `?autostart=live` (or `=demo`); we kick off the
	// matching session method exactly once. The CLI / MCP triggers a stop
	// via `POST /v1/meetings/:id/stop`, which fires `cli:meeting-stop` —
	// we forward it to the session if the id matches.
	const autostartFiredRef = useRef(false);
	// autostart is a one-shot per route mount; depending on
	// session.{startLive,startDemo} would re-run when the hook returns new
	// closures and double-fire.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (autostartFiredRef.current) return;
		const params = new URLSearchParams(window.location.search);
		const autostart = params.get("autostart");
		if (autostart !== "live" && autostart !== "demo" && autostart !== "import")
			return;
		// Defer so the session hook has finished its initial setup. The
		// hook also guards against double-start via runningRef. Set the
		// fired-ref *inside* the timeout, not before — under React strict
		// mode the effect runs twice with a cleanup in between, and the
		// cleanup clears the pending timeout. If we set the ref up front,
		// the second run sees ref=true and bails, so startDemo never fires.
		const handle = setTimeout(() => {
			autostartFiredRef.current = true;
			if (autostart === "live") {
				session.startLive().catch((err) => {
					console.error("[meeting] autostart live failed", err);
				});
			} else if (autostart === "demo") {
				session.startDemo().catch((err) => {
					console.error("[meeting] autostart demo failed", err);
				});
			} else {
				// AIZ-30 — pop the chunks staged by the IPC import endpoint
				// and feed them to startImport. `take_pending_import` returns
				// `null` if the id has no entry (already consumed, or never
				// staged) — in that case there's nothing to do.
				// AIZ-47 — if `streaming: true`, the staged entry has no
				// chunks; whisper is producing them right now and emitting
				// `audio-import-segment` events keyed by `id`. Branch to
				// `startImportStream` so the existing batch loop reads
				// from the stream instead of a static array.
				invoke<{
					chunks: TranscriptChunk[];
					sourceFile: string;
					extractionMode: ExtractionMode;
					source: MeetingSource;
					streaming?: boolean;
				} | null>("take_pending_import", { id })
					.then((pending) => {
						if (!pending) {
							console.warn(
								`[meeting] no pending import for ${id} — nothing to do`,
							);
							return;
						}
						if (pending.streaming) {
							return session.startImportStream(
								id,
								pending.sourceFile,
								pending.extractionMode,
								pending.source,
							);
						}
						return session.startImport(
							pending.chunks,
							pending.sourceFile,
							pending.extractionMode,
							pending.source,
						);
					})
					.catch((err) => {
						console.error("[meeting] autostart import failed", err);
					});
			}
		}, 100);
		return () => clearTimeout(handle);
	}, [id]);

	// re-subscribing on every session.stopLive identity change would tear
	// down the listener mid-stop; the closure already reads the current id.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const unlistenPromise = listen<{ id: string }>(
			"cli:meeting-stop",
			(event) => {
				if (event.payload?.id !== id) return;
				session.stopLive().catch((err) => {
					console.error("[meeting] cli stop failed", err);
				});
			},
		);
		return () => {
			unlistenPromise.then((fn) => fn()).catch(() => {});
		};
	}, [id]);

	// AIZ-47 — cancel-on-close was originally wired here so closing the
	// meeting window mid-import would stop whisper. Pulling it for now:
	// the React-unmount path runs twice under Strict Mode in dev (cancels
	// before the import starts), and the Tauri `onCloseRequested` path
	// appeared to interfere with the close itself. The backend
	// `cancel_audio_import` command stays — re-wire from a more reliable
	// signal in a follow-up.

	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Drop the focused selection if its node disappears (merge / remove).
	useEffect(() => {
		if (!selectedId) return;
		if (!session.graph.nodes.some((n) => n.id === selectedId)) {
			setSelectedId(null);
		}
	}, [session.graph, selectedId]);

	const { positions, settledAt } = useForceLayout(session.graph, selectedId);

	useMeetingDebugSnapshot({
		id,
		name: session.name ?? undefined,
		status: session.status,
		mode: session.mode === "idle" ? undefined : session.mode,
		graph: session.graph,
		positions,
		highlightIds: session.highlightIds,
	});

	const onNodeClick = useCallback((node: AzNode) => {
		setSelectedId((current) => (current === node.id ? null : node.id));
	}, []);
	const onPaneClick = useCallback(() => setSelectedId(null), []);

	return (
		<div
			ref={groupWrapperRef}
			className="aiz-meeting-group h-screen w-screen bg-background"
		>
			<ResizeGroup
				orientation="horizontal"
				resizeTargetMinimumSize={{ fine: 24, coarse: 32 }}
				disableCursor
			>
				<ResizePanel defaultSize={72} minSize={40}>
					<div className="relative h-full w-full">
						<div className="aiz-canvas-shield pointer-events-none absolute inset-0 z-[2000] hidden" />
						<MeetingCanvas
							graph={session.graph}
							positions={positions}
							highlightIds={session.highlightIds}
							selectedId={selectedId}
							settledAt={settledAt}
							onNodeClick={onNodeClick}
							onPaneClick={onPaneClick}
						>
							<div className="pointer-events-none absolute inset-0">
								<div className="pointer-events-auto absolute top-2 left-2">
									<MeetingStatusPanel
										status={session.status}
										mode={session.mode}
										batchIdx={session.batchIdx}
										chunkCount={session.transcript.length}
										graph={session.graph}
										error={session.error}
										stats={session.stats}
										archivedAt={session.archivedAt}
										name={session.name}
										nameLockedByUser={session.nameLockedByUser}
										importStreamSegmentCount={session.importStreamSegmentCount}
										importStreamProgress={session.importStreamProgress}
										importStreamFinished={session.importStreamFinished}
										onSetName={session.setMeetingName}
										onStartDemo={session.startDemo}
										onStartLive={session.startLive}
										onResumeLive={session.resumeLive}
										onStopLive={session.stopLive}
										onPause={session.pauseDemo}
										onResume={session.resumeDemo}
										onReset={session.resetDemo}
									/>
								</div>
								{session.transcript.length > 0 && (
									<div className="-translate-x-1/2 pointer-events-auto absolute bottom-2 left-1/2">
										<LiveTranscript
											chunks={session.transcript}
											passes={session.passes}
											open={session.transcriptOpen}
											onToggle={() => session.setTranscriptOpen((v) => !v)}
										/>
									</div>
								)}
							</div>
						</MeetingCanvas>
					</div>
				</ResizePanel>
				<ResizeSeparator className="group relative w-px bg-transparent">
					<div
						ref={handleRef}
						className="absolute top-1/2 right-1.5 z-50 h-1/2 w-1.5 -translate-y-1/2 cursor-col-resize rounded-full bg-foreground/8 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-150 group-hover:bg-foreground/30 group-hover:shadow-[0_2px_6px_rgba(0,0,0,0.12)]"
					/>
				</ResizeSeparator>
				<ResizePanel
					id="aiz-outline-panel"
					panelRef={outlinePanelRef}
					defaultSize={28}
					minSize={1}
					collapsible
					collapsedSize={0}
					onResize={handleOutlineResize}
				>
					<MeetingOutline
						graph={session.graph}
						status={session.status}
						generatingNotes={session.generatingNotes}
						onGenerateNotes={session.generateNotes}
					/>
				</ResizePanel>
			</ResizeGroup>
		</div>
	);
}

export const Route = createFileRoute("/meeting/$id")({
	component: MeetingPrototype,
});

export type { AzEdge, AzNode };
