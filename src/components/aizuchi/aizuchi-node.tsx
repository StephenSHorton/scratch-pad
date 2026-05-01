import type { NodeProps } from "@xyflow/react";
import {
	Node,
	NodeContent,
	NodeDescription,
	NodeHeader,
	NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import type { Node as AzNode, NodeType } from "@/lib/aizuchi/schemas";

interface AizuchiNodeData {
	node: AzNode;
	highlighted: boolean;
}

const TYPE_BADGE: Record<NodeType, string> = {
	person: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
	topic: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
	work_item: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
	action_item: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	decision: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
	blocker: "bg-red-500/15 text-red-700 dark:text-red-300",
	question: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	context: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
};

export function AizuchiNode({ data }: NodeProps) {
	const { node, highlighted } = data as unknown as AizuchiNodeData;
	return (
		<Node
			handles={{ target: true, source: true }}
			className={cn(
				"transition-all duration-300",
				highlighted && "ring-2 ring-emerald-400 shadow-lg",
			)}
		>
			<NodeHeader>
				<div className="flex items-center justify-between gap-2">
					<NodeTitle className="text-sm">{node.label}</NodeTitle>
					<span
						className={cn(
							"rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
							TYPE_BADGE[node.type],
						)}
					>
						{node.type.replace("_", " ")}
					</span>
				</div>
				{node.speaker && (
					<NodeDescription className="text-xs">
						by {node.speaker}
					</NodeDescription>
				)}
			</NodeHeader>
			{node.description && (
				<NodeContent className="text-xs text-muted-foreground">
					{node.description}
				</NodeContent>
			)}
		</Node>
	);
}
