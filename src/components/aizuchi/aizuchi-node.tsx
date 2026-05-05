import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Card } from "@/components/ui/card";
import type {
	Node as AzNode,
	NodeConfidence,
	NodeStatus,
	NodeType,
} from "@/lib/aizuchi/schemas";
import { cn } from "@/lib/utils";

interface AizuchiNodeData {
	node: AzNode;
	/** AI-recent-change highlight (the AI just touched this node). */
	highlighted: boolean;
	/** Click-to-select neighborhood highlight (this node is in the selected set). */
	inNeighborhood?: boolean;
	/** This node IS the click-target (root of the neighborhood). */
	isFocused?: boolean;
	/** A neighborhood is selected somewhere; nodes outside it should fade. */
	dimmed?: boolean;
}

const TYPE_STYLE: Record<NodeType, { accent: string; ring: string }> = {
	person: { accent: "bg-indigo-500", ring: "ring-indigo-500/40" },
	topic: { accent: "bg-slate-500", ring: "ring-slate-500/40" },
	work_item: { accent: "bg-cyan-500", ring: "ring-cyan-500/40" },
	action_item: { accent: "bg-emerald-500", ring: "ring-emerald-500/40" },
	decision: { accent: "bg-violet-500", ring: "ring-violet-500/40" },
	blocker: { accent: "bg-red-500", ring: "ring-red-500/40" },
	question: { accent: "bg-amber-500", ring: "ring-amber-500/40" },
	context: { accent: "bg-zinc-500", ring: "ring-zinc-500/40" },
	risk: { accent: "bg-rose-500", ring: "ring-rose-500/40" },
	assumption: { accent: "bg-yellow-500", ring: "ring-yellow-500/40" },
	constraint: { accent: "bg-orange-500", ring: "ring-orange-500/40" },
	hypothesis: { accent: "bg-sky-500", ring: "ring-sky-500/40" },
	metric: { accent: "bg-teal-500", ring: "ring-teal-500/40" },
	artifact: { accent: "bg-stone-500", ring: "ring-stone-500/40" },
	event: { accent: "bg-fuchsia-500", ring: "ring-fuchsia-500/40" },
	sentiment: { accent: "bg-pink-500", ring: "ring-pink-500/40" },
};

const TYPE_LABEL: Record<NodeType, string> = {
	person: "Person",
	topic: "Topic",
	work_item: "Work item",
	action_item: "Action",
	decision: "Decision",
	blocker: "Blocker",
	question: "Question",
	context: "Context",
	risk: "Risk",
	assumption: "Assumption",
	constraint: "Constraint",
	hypothesis: "Hypothesis",
	metric: "Metric",
	artifact: "Artifact",
	event: "Event",
	sentiment: "Sentiment",
};

const SIDES = [
	{ pos: Position.Left, key: "left" },
	{ pos: Position.Right, key: "right" },
	{ pos: Position.Top, key: "top" },
	{ pos: Position.Bottom, key: "bottom" },
] as const;

export function AizuchiNode({ data }: NodeProps) {
	const { node, highlighted, inNeighborhood, isFocused, dimmed } =
		data as unknown as AizuchiNodeData;
	const style = TYPE_STYLE[node.type];
	const status: NodeStatus = node.status ?? "active";
	const confidence: NodeConfidence = node.confidence ?? "high";

	const dimClass = dimmed && !inNeighborhood ? "opacity-30" : "";
	const statusClass =
		status === "resolved"
			? "saturate-50"
			: status === "parked"
				? "opacity-60"
				: "";
	const confidenceBorder =
		confidence === "low"
			? "border-dashed border-2"
			: confidence === "medium"
				? "border-dotted border-2"
				: "";

	const ringClass = highlighted
		? "ring-2 ring-emerald-400 shadow-lg shadow-emerald-500/20"
		: isFocused
			? cn("ring-2 shadow-lg", style.ring)
			: inNeighborhood
				? cn("ring-1", style.ring)
				: "";

	const showFooter =
		!!node.quote ||
		(node.tags?.length ?? 0) > 0 ||
		status !== "active" ||
		confidence !== "high";

	return (
		<Card
			className={cn(
				"relative w-sm gap-0 overflow-hidden rounded-md p-0 transition-all duration-300",
				confidenceBorder,
				statusClass,
				dimClass,
				ringClass,
			)}
		>
			<span
				aria-hidden
				className={cn("absolute top-0 bottom-0 left-0 w-1", style.accent)}
			/>

			{SIDES.map(({ pos, key }) => (
				<div key={key}>
					<Handle
						id={`t-${key}`}
						type="target"
						position={pos}
						className="!h-2 !w-2 !border-background"
					/>
					<Handle
						id={`s-${key}`}
						type="source"
						position={pos}
						className="!h-2 !w-2 !border-background"
					/>
				</div>
			))}

			<div className="px-3 pt-3 pb-2 pl-4">
				<div className="flex items-start justify-between gap-2">
					<div
						className={cn(
							"text-sm font-semibold leading-snug",
							status === "resolved" && "line-through decoration-1",
						)}
					>
						{node.label}
					</div>
					<span className="shrink-0 select-none text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
						{TYPE_LABEL[node.type]}
					</span>
				</div>
				{node.speaker && (
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						{node.speaker}
					</div>
				)}
				{node.description && (
					<div className="mt-1 text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
			</div>

			{showFooter && (
				<div className="border-t bg-muted/30 px-3 py-2 pl-4 text-[11px]">
					{node.quote && (
						<blockquote
							className="border-l-2 border-muted-foreground/30 pl-2 italic text-muted-foreground"
							title={node.quote}
						>
							“{node.quote}”
						</blockquote>
					)}
					{((node.tags?.length ?? 0) > 0 ||
						status !== "active" ||
						confidence !== "high") && (
						<div
							className={cn(
								"flex flex-wrap items-center gap-1",
								node.quote && "mt-1.5",
							)}
						>
							{node.tags?.map((tag) => (
								<span
									key={tag}
									className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/70"
								>
									#{tag}
								</span>
							))}
							{status === "parked" && (
								<span className="rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300">
									parked
								</span>
							)}
							{status === "resolved" && (
								<span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
									resolved
								</span>
							)}
							{confidence !== "high" && (
								<span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
									{confidence} confidence
								</span>
							)}
						</div>
					)}
				</div>
			)}
		</Card>
	);
}
