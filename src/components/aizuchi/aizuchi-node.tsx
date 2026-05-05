import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
	Node,
	NodeContent,
	NodeDescription,
	NodeHeader,
	NodeTitle,
} from "@/components/ai-elements/node";
import type { Node as AzNode, NodeType } from "@/lib/aizuchi/schemas";
import { cn } from "@/lib/utils";

interface AizuchiNodeData {
	node: AzNode;
	highlighted: boolean;
}

/**
 * AIZ-12 — visual treatment per node type. Each entry: badge styling for
 * the type pill in the header, plus a left side-stripe color so types are
 * scannable at a glance even with the badge off-screen.
 */
const TYPE_STYLE: Record<NodeType, { badge: string; stripe: string }> = {
	person: {
		badge: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
		stripe: "bg-indigo-500",
	},
	topic: {
		badge: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
		stripe: "bg-slate-500",
	},
	work_item: {
		badge: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
		stripe: "bg-cyan-500",
	},
	action_item: {
		badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
		stripe: "bg-emerald-500",
	},
	decision: {
		badge: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
		stripe: "bg-violet-500",
	},
	blocker: {
		badge: "bg-red-500/15 text-red-700 dark:text-red-300",
		stripe: "bg-red-500",
	},
	question: {
		badge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
		stripe: "bg-amber-500",
	},
	context: {
		badge: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
		stripe: "bg-zinc-500",
	},
	// AIZ-12 — richer vocabulary
	risk: {
		badge: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
		stripe: "bg-rose-500",
	},
	assumption: {
		badge: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
		stripe: "bg-yellow-500",
	},
	constraint: {
		badge: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
		stripe: "bg-orange-500",
	},
	hypothesis: {
		badge: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
		stripe: "bg-sky-500",
	},
	metric: {
		badge: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
		stripe: "bg-teal-500",
	},
	artifact: {
		badge: "bg-stone-500/15 text-stone-700 dark:text-stone-300",
		stripe: "bg-stone-500",
	},
	event: {
		badge: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
		stripe: "bg-fuchsia-500",
	},
	sentiment: {
		badge: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
		stripe: "bg-pink-500",
	},
};

const TYPE_GLYPH: Record<NodeType, string> = {
	person: "◉",
	topic: "•",
	work_item: "▣",
	action_item: "▶",
	decision: "✓",
	blocker: "■",
	question: "?",
	context: "·",
	risk: "⚠",
	assumption: "≈",
	constraint: "⛓",
	hypothesis: "?·",
	metric: "#",
	artifact: "▤",
	event: "◆",
	sentiment: "♥",
};

/**
 * AIZ-12 — handles on all four sides so edges can land on the side that
 * makes geometric sense. Each side has both a source and a target handle
 * (overlaid at the same point). The layout in `meeting.$id.tsx` chooses
 * `sourceHandle` / `targetHandle` per edge based on relative node
 * positions, so paths don't loop awkwardly when the producer is below
 * or above the consumer.
 */
const SIDES = [
	{ pos: Position.Left, key: "left" },
	{ pos: Position.Right, key: "right" },
	{ pos: Position.Top, key: "top" },
	{ pos: Position.Bottom, key: "bottom" },
] as const;

export function AizuchiNode({ data }: NodeProps) {
	const { node, highlighted } = data as unknown as AizuchiNodeData;
	const style = TYPE_STYLE[node.type];
	const glyph = TYPE_GLYPH[node.type];
	const status = node.status ?? "active";
	const confidence = node.confidence ?? "high";

	const confidenceClass =
		confidence === "low"
			? "opacity-70"
			: confidence === "medium"
				? "opacity-90"
				: "";

	const statusClass =
		status === "resolved"
			? "saturate-50"
			: status === "parked"
				? "opacity-60"
				: "";

	return (
		<Node
			handles={{ target: false, source: false }}
			className={cn(
				"relative overflow-hidden transition-all duration-300",
				confidenceClass,
				statusClass,
				highlighted && "ring-2 ring-emerald-400 shadow-lg",
			)}
		>
			{/* Side stripe — type color */}
			<span
				aria-hidden
				className={cn(
					"absolute top-0 bottom-0 left-0 w-1 rounded-l-md",
					style.stripe,
				)}
			/>

			{SIDES.map(({ pos, key }) => (
				<div key={key}>
					<Handle
						id={`t-${key}`}
						type="target"
						position={pos}
						className="!h-2 !w-2"
					/>
					<Handle
						id={`s-${key}`}
						type="source"
						position={pos}
						className="!h-2 !w-2"
					/>
				</div>
			))}

			<NodeHeader>
				<div className="flex items-center justify-between gap-2">
					<NodeTitle
						className={cn(
							"text-sm",
							status === "resolved" && "line-through decoration-1",
						)}
					>
						<span aria-hidden className="mr-1 opacity-70">
							{glyph}
						</span>
						{node.label}
					</NodeTitle>
					<span
						className={cn(
							"rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
							style.badge,
						)}
					>
						{node.type.replace(/_/g, " ")}
					</span>
				</div>
				{(node.speaker || confidence !== "high") && (
					<NodeDescription className="text-xs">
						{node.speaker && <span>by {node.speaker}</span>}
						{node.speaker && confidence !== "high" && (
							<span className="opacity-50"> · </span>
						)}
						{confidence !== "high" && (
							<span className="opacity-70">~{confidence} confidence</span>
						)}
					</NodeDescription>
				)}
			</NodeHeader>
			{(node.description || node.quote || (node.tags?.length ?? 0) > 0) && (
				<NodeContent className="text-xs text-muted-foreground">
					{node.description && <div>{node.description}</div>}
					{node.quote && (
						<blockquote
							className="mt-1.5 border-l-2 border-muted-foreground/30 pl-2 italic"
							title={node.quote}
						>
							“{node.quote}”
						</blockquote>
					)}
					{node.tags && node.tags.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{node.tags.map((tag) => (
								<span
									key={tag}
									className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/70"
								>
									#{tag}
								</span>
							))}
						</div>
					)}
				</NodeContent>
			)}
		</Node>
	);
}
