import { useEffect, useRef, useState } from "react";
import type { Mode, RunStats, Status } from "@/hooks/useMeetingSession";
import { SPEED_MULTIPLIER } from "@/hooks/useMeetingSession";
import type { AudioImportPhase } from "@/lib/aizuchi/feeder";
import type { Graph } from "@/lib/aizuchi/schemas";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function MeetingStatusPanel({
	status,
	mode,
	batchIdx,
	chunkCount,
	graph,
	error,
	stats,
	archivedAt,
	name,
	nameLockedByUser,
	importStreamSegmentCount,
	importStreamProgress,
	importStreamFinished,
	importStreamPhase,
	onSetName,
	onStartDemo,
	onStartLive,
	onResumeLive,
	onStopLive,
	onPause,
	onResume,
	onReset,
}: {
	status: Status;
	mode: Mode;
	batchIdx: number;
	chunkCount: number;
	graph: Graph;
	error: string | null;
	stats: RunStats;
	archivedAt: number | null;
	name: string | null;
	nameLockedByUser: boolean;
	importStreamSegmentCount: number;
	importStreamProgress: number;
	importStreamFinished: boolean;
	importStreamPhase: AudioImportPhase | null;
	onSetName: (name: string) => void;
	onStartDemo: () => void;
	onStartLive: () => void;
	onResumeLive: () => void;
	onStopLive: () => void;
	onPause: () => void;
	onResume: () => void;
	onReset: () => void;
}) {
	const isArchived = status === "archived";

	const dot =
		status === "listening"
			? "bg-amber-500 animate-pulse"
			: status === "thinking"
				? "bg-violet-500 animate-pulse"
				: status === "finalizing"
					? "bg-fuchsia-500 animate-pulse"
					: status === "updated"
						? "bg-emerald-500"
						: status === "paused"
							? "bg-zinc-400"
							: status === "done"
								? "bg-sky-500"
								: status === "error"
									? "bg-red-500"
									: status === "archived"
										? "bg-zinc-400"
										: "bg-muted-foreground";

	const label =
		status === "listening"
			? "listening…"
			: status === "thinking"
				? "thinking…"
				: status === "finalizing"
					? "Final review…"
					: status === "updated"
						? "map updated"
						: status === "paused"
							? "paused"
							: status === "done"
								? "transcript complete"
								: status === "error"
									? "error"
									: status === "archived"
										? "viewing"
										: "idle";

	const isRunning =
		status === "listening" || status === "thinking" || status === "updated";
	const canStart =
		!isArchived &&
		(status === "idle" || status === "done" || status === "error");
	const isLive = mode === "live";
	const isDemo = mode === "demo";

	const archivedLabel = archivedAt
		? new Date(archivedAt).toLocaleString(undefined, {
				weekday: "short",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})
		: null;

	return (
		<div className="flex min-w-[280px] flex-col gap-2 px-3 py-2 text-xs">
			<MeetingNameField
				name={name}
				nameLockedByUser={nameLockedByUser}
				onSetName={onSetName}
			/>
			<div className="flex items-center gap-2">
				<span className={`size-2 rounded-full ${dot}`} />
				<span className="font-medium">{label}</span>
				{mode !== "idle" && !isArchived && (
					<span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						{mode}
					</span>
				)}
				{isArchived && (
					<span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
						archived
					</span>
				)}
				<span className="ml-auto text-muted-foreground">batch {batchIdx}</span>
			</div>
			{isArchived && archivedLabel && (
				<div className="text-[11px] text-muted-foreground">
					Archived — {archivedLabel}
				</div>
			)}
			{mode === "import" && !importStreamFinished && !isArchived && (
				<ImportStreamStatus
					phase={importStreamPhase}
					segmentCount={importStreamSegmentCount}
					progress={importStreamProgress}
				/>
			)}
			<div className="text-muted-foreground">
				{graph.nodes.length} nodes · {graph.edges.length} edges
				{mode === "live" && (
					<>
						{" · "}
						<span className={chunkCount === 0 ? "text-amber-500" : ""}>
							{chunkCount} chunk{chunkCount === 1 ? "" : "s"}
						</span>
					</>
				)}
			</div>

			<div className="flex flex-wrap gap-1.5 pt-1">
				{canStart && (
					<>
						<button
							type="button"
							onClick={onStartLive}
							className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"
						>
							● Start live audio
						</button>
						<button
							type="button"
							onClick={onStartDemo}
							className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
						>
							{status === "idle" ? "Run demo transcript" : "Replay demo"}
						</button>
					</>
				)}
				{isRunning && isDemo && (
					<button
						type="button"
						onClick={onPause}
						className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-500"
					>
						Pause
					</button>
				)}
				{isRunning && isLive && (
					<button
						type="button"
						onClick={onStopLive}
						className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"
					>
						Stop
					</button>
				)}
				{status === "paused" && (
					<button
						type="button"
						onClick={onResume}
						className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
					>
						Resume
					</button>
				)}
				{(isRunning || status === "paused" || status === "done") && (
					<button
						type="button"
						onClick={onReset}
						className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
					>
						Reset
					</button>
				)}
				{isArchived && isLive && (
					<button
						type="button"
						onClick={onResumeLive}
						className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"
					>
						● Resume
					</button>
				)}
				{isArchived && (
					<button
						type="button"
						onClick={onReset}
						className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
					>
						Close
					</button>
				)}
			</div>

			{status === "idle" && (
				<div className="rounded border border-border/40 bg-muted/30 p-2 text-[11px] text-muted-foreground">
					<strong className="text-foreground">Live audio</strong>: streams mic
					into whisper, populates the map every ~2s.{" "}
					<strong className="text-foreground">Demo</strong>: replays the canned
					standup at {SPEED_MULTIPLIER}× speed.
				</div>
			)}
			{stats.providerLabel && (
				<div className="text-muted-foreground">
					{stats.providerLabel} · {(stats.totalLatencyMs / 1000).toFixed(1)}s
					{stats.totalInputTokens
						? ` · ${stats.totalInputTokens}↓ ${stats.totalOutputTokens}↑ tok`
						: ""}
				</div>
			)}
			{error && (
				<div className="mt-1 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-700">
					{error}
					{error.toLowerCase().includes("fetch") && (
						<div className="mt-1 text-[10px] text-red-700/80">
							Ollama may need <code>OLLAMA_ORIGINS=*</code> to accept
							cross-origin requests. Restart with{" "}
							<code>OLLAMA_ORIGINS=* ollama serve</code>.
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// AIZ-16 — inline-editable meeting name. Click-to-edit, Enter to commit,
// Esc to cancel. Visually matches the rest of the panel: single line, no modal.
function MeetingNameField({
	name,
	nameLockedByUser,
	onSetName,
}: {
	name: string | null;
	nameLockedByUser: boolean;
	onSetName: (name: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(name ?? "");
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (editing) return;
		setDraft(name ?? "");
	}, [name, editing]);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [editing]);

	const commit = () => {
		const trimmed = draft.trim();
		if (trimmed && trimmed !== name) onSetName(trimmed);
		setEditing(false);
	};

	const cancel = () => {
		setDraft(name ?? "");
		setEditing(false);
	};

	if (editing) {
		return (
			<input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						cancel();
					}
				}}
				placeholder="Untitled meeting"
				className="w-full rounded border border-border bg-background px-1.5 py-0.5 text-sm font-medium outline-none focus:border-primary"
			/>
		);
	}

	const displayName = name ?? "Untitled meeting";
	const isPlaceholder = !name;

	return (
		<button
			type="button"
			onClick={() => setEditing(true)}
			title={
				nameLockedByUser ? "Custom name (click to edit)" : "Click to rename"
			}
			className={`-mx-1 truncate rounded px-1 py-0.5 text-left text-sm font-medium hover:bg-muted/50 ${
				isPlaceholder ? "text-muted-foreground italic" : "text-foreground"
			}`}
		>
			{displayName}
		</button>
	);
}

// AIZ-38 — phased status pill for streaming audio imports. Renders the
// current phase's label, falling back to the AIZ-47 "Whisper transcribing
// X%" copy when no phase event has fired yet (e.g. the very first frame
// before the worker thread starts). During `downloading-model` we show
// byte counts; during whisper inference we show the percent + segment
// count. `decoding` / `staging` are intentionally indeterminate: they
// are short-lived and we don't have a meaningful progress fraction.
function ImportStreamStatus({
	phase,
	segmentCount,
	progress,
}: {
	phase: AudioImportPhase | null;
	segmentCount: number;
	progress: number;
}) {
	let label: string;
	let barPercent: number | null;
	let detail: string | null;

	if (phase === null) {
		label = "Whisper transcribing…";
		barPercent = progress;
		detail = `${progress}% (${segmentCount} segment${
			segmentCount === 1 ? "" : "s"
		})`;
	} else if (phase.phase === "downloading-model") {
		label = phase.label;
		barPercent = phase.percent ?? null;
		if (phase.bytes !== undefined && phase.total !== undefined) {
			detail = `${formatBytes(phase.bytes)} / ${formatBytes(phase.total)}`;
		} else if (phase.bytes !== undefined) {
			detail = formatBytes(phase.bytes);
		} else {
			detail = null;
		}
	} else if (phase.phase === "transcribing") {
		label = "Whisper transcribing…";
		barPercent = progress;
		detail = `${progress}% (${segmentCount} segment${
			segmentCount === 1 ? "" : "s"
		})`;
	} else if (phase.phase === "staging") {
		label = phase.label;
		barPercent = 100;
		detail = `${segmentCount} segment${segmentCount === 1 ? "" : "s"}`;
	} else {
		// `decoding` and any future indeterminate phase fall here.
		label = phase.label;
		barPercent = null;
		detail = null;
	}

	return (
		<div className="flex flex-col gap-1 text-[11px] text-amber-700 dark:text-amber-300">
			<div className="flex items-center gap-1.5">
				<span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
				<span>{label}</span>
				{detail && (
					<span className="text-amber-700/70 dark:text-amber-300/70">
						{detail}
					</span>
				)}
			</div>
			<div className="h-1 w-full overflow-hidden rounded-full bg-amber-500/15">
				{barPercent === null ? (
					<div className="h-full w-1/3 animate-pulse bg-amber-500" />
				) : (
					<div
						className="h-full bg-amber-500 transition-[width] duration-300 ease-out"
						style={{ width: `${barPercent}%` }}
					/>
				)}
			</div>
		</div>
	);
}
