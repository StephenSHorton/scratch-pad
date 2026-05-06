import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";
import type { Node as AzNode, Graph } from "@/lib/aizuchi/schemas";

/**
 * AIZ-45 — read-only timeline strip docked below the meeting canvas.
 *
 * Renders one chip per `event` node in chronological order (parsed
 * `occurredAt`) or insertion order when the model didn't supply a
 * sortable hint. `precedes` edges between two events render as a thin
 * connector line under the chips. Clicking a chip selects the
 * corresponding canvas node; hovering an event in the canvas
 * highlights the chip in the strip.
 *
 * Selection / hover state is owned by the parent route — this is a
 * pure render of the slice that lives inside the strip. Returns
 * `null` when there are no event nodes (the strip hides entirely;
 * no empty state).
 */

const STRIP_HEIGHT = 80;
const CHIP_GAP = 12;
const EVENT_COLOR = "rgb(217, 70, 239)"; // fuchsia, matches MeetingCanvas TYPE_COLOR.event

interface EventTimelineStripProps {
	graph: Graph;
	selectedId: string | null;
	hoveredEventId: string | null;
	onSelect: (id: string) => void;
	onHoverChange: (id: string | null) => void;
}

interface OrderedEvent {
	node: AzNode;
	/** Numeric timestamp when `occurredAt` parsed cleanly; null otherwise. */
	ts: number | null;
	/** Position in the original `graph.nodes` array. Stable tiebreak. */
	insertionIdx: number;
}

function orderEvents(graph: Graph): OrderedEvent[] {
	const events: OrderedEvent[] = [];
	for (let i = 0; i < graph.nodes.length; i++) {
		const n = graph.nodes[i];
		if (!n || n.type !== "event") continue;
		const parsed = n.occurredAt ? Date.parse(n.occurredAt) : Number.NaN;
		events.push({
			node: n,
			ts: Number.isFinite(parsed) ? parsed : null,
			insertionIdx: i,
		});
	}
	// Parsed timestamps sort first by date; un-parseable trail by insertion
	// order. Within parseable, ties break by insertion order so two events
	// claiming the same day don't jitter on every recompute.
	events.sort((a, b) => {
		if (a.ts !== null && b.ts !== null) {
			if (a.ts !== b.ts) return a.ts - b.ts;
			return a.insertionIdx - b.insertionIdx;
		}
		if (a.ts !== null) return -1;
		if (b.ts !== null) return 1;
		return a.insertionIdx - b.insertionIdx;
	});
	return events;
}

function formatDateLabel(occurredAt: string | undefined): string | null {
	if (!occurredAt) return null;
	const d = new Date(occurredAt);
	if (Number.isNaN(d.getTime())) {
		// Natural-language hint — keep a short version.
		return occurredAt.length > 14 ? `${occurredAt.slice(0, 12)}…` : occurredAt;
	}
	const m = d.toLocaleString("en-US", { month: "short" });
	return `${m} ${d.getDate()}`;
}

export function EventTimelineStrip({
	graph,
	selectedId,
	hoveredEventId,
	onSelect,
	onHoverChange,
}: EventTimelineStripProps) {
	const ordered = useMemo(() => orderEvents(graph), [graph]);

	// Lookup of event id → strip-position index for the precedes connectors.
	const indexById = useMemo(() => {
		const map = new Map<string, number>();
		for (let i = 0; i < ordered.length; i++) {
			const ev = ordered[i];
			if (!ev) continue;
			map.set(ev.node.id, i);
		}
		return map;
	}, [ordered]);

	// Only render `precedes` edges that connect two events both in the strip.
	const precedesPairs = useMemo(() => {
		const pairs: Array<{ id: string; from: number; to: number }> = [];
		for (const e of graph.edges) {
			if (e.relation !== "precedes") continue;
			const from = indexById.get(e.from);
			const to = indexById.get(e.to);
			if (from === undefined || to === undefined) continue;
			pairs.push({ id: e.id, from, to });
		}
		return pairs;
	}, [graph.edges, indexById]);

	if (ordered.length === 0) return null;

	return (
		<section
			aria-label="Event timeline"
			className="relative w-full shrink-0 overflow-hidden border-t border-border/60 bg-background/90 backdrop-blur"
			style={{ height: STRIP_HEIGHT }}
		>
			{/* Horizontal scroller — chips wrap not, scroll on overflow. */}
			<div
				className="flex h-full items-center overflow-x-auto overflow-y-hidden px-3"
				style={{ gap: CHIP_GAP }}
			>
				<AnimatePresence initial={false}>
					{ordered.map((ev, i) => {
						const isSelected = ev.node.id === selectedId;
						const isHovered = ev.node.id === hoveredEventId;
						const dateLabel = formatDateLabel(ev.node.occurredAt);
						const next = ordered[i + 1];
						const linkedToNext =
							next !== undefined &&
							precedesPairs.some((p) => p.from === i && p.to === i + 1);
						return (
							<motion.button
								key={ev.node.id}
								type="button"
								layout
								initial={{ opacity: 0, y: 8, scale: 0.92 }}
								animate={{ opacity: 1, y: 0, scale: 1 }}
								exit={{ opacity: 0, y: 8, scale: 0.92 }}
								transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
								onClick={() => onSelect(ev.node.id)}
								onMouseEnter={() => onHoverChange(ev.node.id)}
								onMouseLeave={() => onHoverChange(null)}
								onFocus={() => onHoverChange(ev.node.id)}
								onBlur={() => onHoverChange(null)}
								aria-pressed={isSelected}
								title={ev.node.label}
								className={`relative flex h-12 max-w-[220px] shrink-0 items-center gap-2 rounded-full border px-3 text-left transition-all duration-150 ${
									isSelected
										? "border-fuchsia-500 bg-fuchsia-500/10 shadow-[0_0_0_2px_rgba(217,70,239,0.25)]"
										: isHovered
											? "border-fuchsia-500/70 bg-fuchsia-500/5"
											: "border-border bg-background hover:border-fuchsia-500/50"
								}`}
							>
								<span
									aria-hidden
									className="size-2 shrink-0 rounded-full"
									style={{ backgroundColor: EVENT_COLOR }}
								/>
								<span className="flex min-w-0 flex-col">
									<span className="truncate text-xs font-semibold leading-tight text-foreground">
										{ev.node.label}
									</span>
									{dateLabel ? (
										<span className="truncate text-[10px] uppercase tracking-wider leading-tight text-muted-foreground">
											{dateLabel}
										</span>
									) : null}
								</span>
								{/* Chevron-style connector when this chip precedes the next. */}
								{linkedToNext ? (
									<span
										aria-hidden
										className="-right-3 absolute top-1/2 h-px w-3 -translate-y-1/2"
										style={{ backgroundColor: EVENT_COLOR, opacity: 0.55 }}
									/>
								) : null}
							</motion.button>
						);
					})}
				</AnimatePresence>
			</div>
		</section>
	);
}
