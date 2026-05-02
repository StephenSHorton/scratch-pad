import type { Mode, RunStats, Status } from "@/hooks/useMeetingSession";
import { SPEED_MULTIPLIER } from "@/hooks/useMeetingSession";
import type { Graph } from "@/lib/aizuchi/schemas";

export function MeetingStatusPanel({
	status,
	mode,
	batchIdx,
	chunkCount,
	graph,
	error,
	stats,
	generatingNotes,
	archivedAt,
	onStartDemo,
	onStartLive,
	onResumeLive,
	onStopLive,
	onPause,
	onResume,
	onReset,
	onGenerateNotes,
}: {
	status: Status;
	mode: Mode;
	batchIdx: number;
	chunkCount: number;
	graph: Graph;
	error: string | null;
	stats: RunStats;
	generatingNotes: boolean;
	archivedAt: number | null;
	onStartDemo: () => void;
	onStartLive: () => void;
	onResumeLive: () => void;
	onStopLive: () => void;
	onPause: () => void;
	onResume: () => void;
	onReset: () => void;
	onGenerateNotes: () => void;
}) {
	const isArchived = status === "archived";

	const dot =
		status === "listening"
			? "bg-amber-500 animate-pulse"
			: status === "thinking"
				? "bg-violet-500 animate-pulse"
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

			{(graph.nodes.length > 0 || status === "done") && (
				<div className="flex flex-wrap gap-1.5">
					<button
						type="button"
						onClick={onGenerateNotes}
						disabled={generatingNotes}
						className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
					>
						{generatingNotes ? "Generating notes…" : "Generate meeting notes"}
					</button>
				</div>
			)}

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
