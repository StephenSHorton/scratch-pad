import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import type {
	Node as AzNode,
	NodeConfidence,
	NodeStatus,
	NodeType,
	Severity,
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

// AIZ-12 — visual treatment per node type.
const TYPE_STYLE: Record<NodeType, { accent: string; ring: string }> = {
	person: { accent: "bg-indigo-500", ring: "ring-indigo-500/30" },
	topic: { accent: "bg-slate-500", ring: "ring-slate-500/30" },
	work_item: { accent: "bg-cyan-500", ring: "ring-cyan-500/30" },
	action_item: { accent: "bg-emerald-500", ring: "ring-emerald-500/30" },
	decision: { accent: "bg-violet-500", ring: "ring-violet-500/30" },
	blocker: { accent: "bg-red-500", ring: "ring-red-500/30" },
	question: { accent: "bg-amber-500", ring: "ring-amber-500/30" },
	context: { accent: "bg-zinc-500", ring: "ring-zinc-500/30" },
	risk: { accent: "bg-rose-500", ring: "ring-rose-500/30" },
	assumption: { accent: "bg-yellow-500", ring: "ring-yellow-500/30" },
	constraint: { accent: "bg-orange-500", ring: "ring-orange-500/30" },
	hypothesis: { accent: "bg-sky-500", ring: "ring-sky-500/30" },
	metric: { accent: "bg-teal-500", ring: "ring-teal-500/30" },
	artifact: { accent: "bg-stone-500", ring: "ring-stone-500/30" },
	event: { accent: "bg-fuchsia-500", ring: "ring-fuchsia-500/30" },
	sentiment: { accent: "bg-pink-500", ring: "ring-pink-500/30" },
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
	return (
		<NodeShell
			node={node}
			aiTouched={highlighted}
			inNeighborhood={!!inNeighborhood}
			isFocused={!!isFocused}
			dimmed={!!dimmed}
		>
			<NodeBody node={node} />
		</NodeShell>
	);
}

interface NodeShellProps {
	node: AzNode;
	aiTouched: boolean;
	inNeighborhood: boolean;
	isFocused: boolean;
	dimmed: boolean;
	children: ReactNode;
}

/**
 * AIZ-12 — shared chrome for every node: 4-side handles, side accent stripe,
 * type label corner badge, status/confidence visual decorations, and the
 * three highlight states (AI-just-touched, in-neighborhood, focused).
 *
 * Type-specific layout lives in `<NodeBody>` and the per-type renderers below.
 */
function NodeShell({
	node,
	aiTouched,
	inNeighborhood,
	isFocused,
	dimmed,
	children,
}: NodeShellProps) {
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

	const ringClass = aiTouched
		? "ring-2 ring-emerald-400 shadow-lg shadow-emerald-500/20"
		: isFocused
			? cn("ring-2 shadow-lg", style.ring.replace("ring-", "ring-"))
			: inNeighborhood
				? cn("ring-1", style.ring)
				: "";

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

			<div className="absolute top-1.5 right-2 select-none text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
				{TYPE_LABEL[node.type]}
			</div>

			{children}

			<NodeFooter node={node} confidence={confidence} status={status} />
		</Card>
	);
}

function NodeFooter({
	node,
	confidence,
	status,
}: {
	node: AzNode;
	confidence: NodeConfidence;
	status: NodeStatus;
}) {
	const showQuote = !!node.quote;
	const showTags = (node.tags?.length ?? 0) > 0;
	const showMeta = confidence !== "high" || status !== "active";
	if (!(showQuote || showTags || showMeta)) return null;
	return (
		<div className="border-t bg-muted/30 px-3 py-2 text-[11px]">
			{showQuote && (
				<blockquote
					className="border-l-2 border-muted-foreground/30 pl-2 italic text-muted-foreground"
					title={node.quote}
				>
					“{node.quote}”
				</blockquote>
			)}
			{(showTags || showMeta) && (
				<div className="mt-1.5 flex flex-wrap items-center gap-1">
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
	);
}

// =============================================================================
// Per-type bodies — each renderer owns the headline area; chrome is shared.
// =============================================================================

function NodeBody({ node }: { node: AzNode }) {
	switch (node.type) {
		case "person":
			return <PersonBody node={node} />;
		case "decision":
			return <DecisionBody node={node} />;
		case "action_item":
			return <ActionItemBody node={node} />;
		case "blocker":
			return <BlockerBody node={node} />;
		case "question":
			return <QuestionBody node={node} />;
		case "risk":
			return <RiskBody node={node} />;
		case "assumption":
			return <AssumptionBody node={node} />;
		case "constraint":
			return <ConstraintBody node={node} />;
		case "hypothesis":
			return <HypothesisBody node={node} />;
		case "metric":
			return <MetricBody node={node} />;
		case "artifact":
			return <ArtifactBody node={node} />;
		case "event":
			return <EventBody node={node} />;
		case "sentiment":
			return <SentimentBody node={node} />;
		case "work_item":
			return <WorkItemBody node={node} />;
		case "topic":
			return <TopicBody node={node} />;
		case "context":
			return <ContextBody node={node} />;
		default:
			return <TopicBody node={node} />;
	}
}

function initials(name: string): string {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

function PersonBody({ node }: { node: AzNode }) {
	const ini = initials(node.label) || "?";
	return (
		<div className="flex items-center gap-3 p-3">
			<div className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-500/15 text-base font-semibold text-indigo-700 dark:text-indigo-300">
				{ini}
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-semibold leading-tight">
					{node.label}
				</div>
				{node.description && (
					<div className="mt-0.5 truncate text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
			</div>
		</div>
	);
}

function DecisionBody({ node }: { node: AzNode }) {
	const resolved = node.status === "resolved";
	return (
		<div>
			<div className="flex items-center gap-1.5 bg-violet-500/15 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-violet-700 dark:text-violet-300">
				<span aria-hidden>✓</span> Decided
			</div>
			<div className="px-3 py-2.5">
				<div
					className={cn(
						"text-sm font-semibold leading-snug",
						resolved && "line-through decoration-1",
					)}
				>
					{node.label}
				</div>
				{node.alternative && (
					<div className="mt-1 text-xs text-muted-foreground">
						over <span className="line-through">{node.alternative}</span>
					</div>
				)}
				{node.description && !node.alternative && (
					<div className="mt-1 text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
			</div>
		</div>
	);
}

function ActionItemBody({ node }: { node: AzNode }) {
	const done = node.status === "resolved";
	return (
		<div className="flex items-start gap-2.5 p-3">
			<div
				className={cn(
					"mt-0.5 h-4 w-4 shrink-0 rounded-sm border-2",
					done ? "border-emerald-500 bg-emerald-500" : "border-emerald-500/60",
				)}
			>
				{done && (
					<svg
						aria-hidden
						viewBox="0 0 16 16"
						className="h-full w-full text-white"
					>
						<title>done</title>
						<path
							d="M3 8l3.5 3.5L13 5"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				)}
			</div>
			<div className="min-w-0 flex-1">
				<div
					className={cn(
						"text-sm font-medium leading-snug",
						done && "line-through decoration-1 text-muted-foreground",
					)}
				>
					{node.label}
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-1.5">
					{node.speaker && (
						<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
							@{node.speaker}
						</span>
					)}
					{node.dueDate && (
						<span className="text-[11px] text-muted-foreground">
							due {node.dueDate}
						</span>
					)}
				</div>
				{node.description && (
					<div className="mt-1 text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
			</div>
		</div>
	);
}

function BlockerBody({ node }: { node: AzNode }) {
	return (
		<div>
			<div className="flex items-center gap-1.5 bg-red-500/15 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-red-700 dark:text-red-300">
				<span aria-hidden>■</span> Blocker
			</div>
			<div className="px-3 py-2.5">
				<div className="text-sm font-semibold leading-snug">{node.label}</div>
				{node.description && (
					<div className="mt-1 text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
			</div>
		</div>
	);
}

function QuestionBody({ node }: { node: AzNode }) {
	const answered = node.status === "resolved";
	return (
		<div className="flex items-start gap-3 p-3">
			<div
				className={cn(
					"flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg font-bold",
					answered
						? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
						: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
				)}
			>
				{answered ? "✓" : "?"}
			</div>
			<div className="min-w-0 flex-1">
				<div
					className={cn(
						"text-sm font-medium leading-snug",
						answered && "text-muted-foreground",
					)}
				>
					{node.label}
				</div>
				{node.speaker && (
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						raised by {node.speaker}
					</div>
				)}
				{node.description && (
					<div className="mt-1 text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
			</div>
		</div>
	);
}

function severityDots(level: Severity | undefined): string {
	if (level === "high") return "●●●";
	if (level === "medium") return "●●○";
	if (level === "low") return "●○○";
	return "○○○";
}

function severityColor(level: Severity | undefined): string {
	if (level === "high") return "text-rose-600 dark:text-rose-400";
	if (level === "medium") return "text-amber-600 dark:text-amber-400";
	if (level === "low") return "text-emerald-600 dark:text-emerald-400";
	return "text-muted-foreground/40";
}

function RiskBody({ node }: { node: AzNode }) {
	return (
		<div>
			<div className="flex items-center justify-between bg-rose-500/15 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-rose-700 dark:text-rose-300">
				<span className="flex items-center gap-1.5">
					<span aria-hidden>⚠</span> Risk
				</span>
			</div>
			<div className="px-3 py-2.5">
				<div className="text-sm font-semibold leading-snug">{node.label}</div>
				{node.description && (
					<div className="mt-1 text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
				{(node.likelihood || node.impact) && (
					<div className="mt-2 grid grid-cols-2 gap-2 rounded bg-rose-500/5 p-2 text-[11px]">
						<div>
							<div className="text-[9px] uppercase tracking-wider text-muted-foreground">
								Likelihood
							</div>
							<div
								className={cn(
									"mt-0.5 font-mono text-base leading-none",
									severityColor(node.likelihood),
								)}
							>
								{severityDots(node.likelihood)}
							</div>
						</div>
						<div>
							<div className="text-[9px] uppercase tracking-wider text-muted-foreground">
								Impact
							</div>
							<div
								className={cn(
									"mt-0.5 font-mono text-base leading-none",
									severityColor(node.impact),
								)}
							>
								{severityDots(node.impact)}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function AssumptionBody({ node }: { node: AzNode }) {
	return (
		<div className="p-3">
			<div className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-yellow-700 dark:text-yellow-300">
				<span aria-hidden>≈</span> Assumes
			</div>
			<div className="text-sm font-medium leading-snug italic">
				{node.label}
			</div>
			{node.description && (
				<div className="mt-1 text-xs text-muted-foreground">
					{node.description}
				</div>
			)}
		</div>
	);
}

function ConstraintBody({ node }: { node: AzNode }) {
	return (
		<div className="p-3">
			<div className="flex items-baseline gap-2">
				<span aria-hidden className="text-orange-500">
					⛓
				</span>
				{node.limit ? (
					<div className="font-mono text-xl font-bold leading-none text-orange-700 dark:text-orange-300">
						{node.limit}
					</div>
				) : (
					<div className="text-sm font-semibold leading-snug">{node.label}</div>
				)}
			</div>
			{node.limit && (
				<div className="mt-1 text-xs text-muted-foreground">{node.label}</div>
			)}
			{node.description && (
				<div className="mt-1 text-xs text-muted-foreground/80">
					{node.description}
				</div>
			)}
		</div>
	);
}

function HypothesisBody({ node }: { node: AzNode }) {
	return (
		<div className="p-3">
			<div className="grid gap-1.5">
				<div>
					<span className="mr-1.5 text-[9px] font-bold uppercase tracking-widest text-sky-700 dark:text-sky-300">
						If
					</span>
					<span className="text-sm font-medium">{node.label}</span>
				</div>
				{node.prediction && (
					<div>
						<span className="mr-1.5 text-[9px] font-bold uppercase tracking-widest text-sky-700 dark:text-sky-300">
							Then
						</span>
						<span className="text-sm">{node.prediction}</span>
					</div>
				)}
			</div>
			{node.description && !node.prediction && (
				<div className="mt-1 text-xs text-muted-foreground">
					{node.description}
				</div>
			)}
		</div>
	);
}

function MetricBody({ node }: { node: AzNode }) {
	return (
		<div className="p-3">
			<div className="text-[11px] font-medium text-muted-foreground">
				{node.label}
			</div>
			<div className="mt-0.5 flex items-baseline gap-2">
				{node.value ? (
					<>
						<div className="font-mono text-3xl font-bold leading-none text-teal-700 dark:text-teal-300">
							{node.value}
						</div>
						{node.unit && (
							<div className="font-mono text-sm text-muted-foreground">
								{node.unit}
							</div>
						)}
					</>
				) : (
					<div className="font-mono text-base font-semibold text-muted-foreground/70">
						—
					</div>
				)}
				{node.target && (
					<div className="ml-auto self-end text-[11px] text-muted-foreground">
						→ {node.target}
					</div>
				)}
			</div>
			{node.description && (
				<div className="mt-1.5 text-xs text-muted-foreground">
					{node.description}
				</div>
			)}
		</div>
	);
}

function ArtifactBody({ node }: { node: AzNode }) {
	return (
		<div className="p-3">
			<div className="flex items-start gap-2.5">
				<span
					aria-hidden
					className="mt-0.5 inline-block rounded-sm border-2 border-stone-500/40 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-stone-600 dark:text-stone-400"
				>
					Doc
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-sm font-medium">
						{node.label}
					</div>
					{node.description && (
						<div className="mt-0.5 text-xs text-muted-foreground">
							{node.description}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function EventBody({ node }: { node: AzNode }) {
	return (
		<div className="flex items-start gap-3 p-3">
			<div
				className="flex w-12 shrink-0 flex-col items-center overflow-hidden rounded border border-fuchsia-500/30"
				aria-hidden
			>
				<div className="w-full bg-fuchsia-500/15 px-1 text-center text-[8px] font-bold uppercase tracking-widest text-fuchsia-700 dark:text-fuchsia-300">
					{node.occurredAt ? "When" : "Event"}
				</div>
				<div className="px-1 py-1 text-center font-mono text-[10px] font-semibold leading-tight text-fuchsia-700 dark:text-fuchsia-300">
					{node.occurredAt ?? "—"}
				</div>
			</div>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-semibold leading-snug">{node.label}</div>
				{node.description && (
					<div className="mt-1 text-xs text-muted-foreground">
						{node.description}
					</div>
				)}
			</div>
		</div>
	);
}

function SentimentBody({ node }: { node: AzNode }) {
	const tone = node.tone ?? "—";
	return (
		<div className="p-3">
			<div className="flex items-baseline gap-2">
				<span aria-hidden className="text-pink-500">
					♥
				</span>
				<div className="text-base font-semibold capitalize text-pink-700 dark:text-pink-300">
					{tone}
				</div>
				<div className="text-xs text-muted-foreground">about</div>
			</div>
			<div className="mt-0.5 text-sm leading-snug">{node.label}</div>
			{node.speaker && (
				<div className="mt-1 text-[11px] text-muted-foreground">
					{node.speaker}
				</div>
			)}
		</div>
	);
}

function WorkItemBody({ node }: { node: AzNode }) {
	return (
		<div className="p-3">
			<div className="flex items-start gap-2">
				<span
					aria-hidden
					className="mt-1 inline-block h-2 w-2 shrink-0 rounded-sm bg-cyan-500"
				/>
				<div className="min-w-0 flex-1">
					<div className="text-sm font-semibold leading-snug">{node.label}</div>
					{node.speaker && (
						<div className="mt-0.5 text-[11px] text-muted-foreground">
							owned by {node.speaker}
						</div>
					)}
					{node.description && (
						<div className="mt-1 text-xs text-muted-foreground">
							{node.description}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function TopicBody({ node }: { node: AzNode }) {
	return (
		<div className="p-3">
			<div className="text-sm font-medium leading-snug">{node.label}</div>
			{node.description && (
				<div className="mt-1 text-xs text-muted-foreground">
					{node.description}
				</div>
			)}
		</div>
	);
}

function ContextBody({ node }: { node: AzNode }) {
	return (
		<div className="bg-zinc-500/5 p-3">
			<div className="text-xs leading-snug text-muted-foreground">
				{node.label}
			</div>
			{node.description && (
				<div className="mt-1 text-[11px] text-muted-foreground/80">
					{node.description}
				</div>
			)}
		</div>
	);
}
