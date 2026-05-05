import { useMemo } from "react";
import type { Status } from "@/hooks/useMeetingSession";
import type { Node as AzNode, Graph, NodeType } from "@/lib/aizuchi/schemas";

const SECTION_ORDER: { type: NodeType; label: string }[] = [
	{ type: "person", label: "People" },
	{ type: "decision", label: "Decisions" },
	{ type: "action_item", label: "Action items" },
	{ type: "blocker", label: "Blockers" },
	{ type: "question", label: "Questions" },
	{ type: "work_item", label: "Work items" },
	{ type: "topic", label: "Topics" },
	{ type: "context", label: "Context" },
];

export function MeetingOutline({
	graph,
	status,
	generatingNotes,
	onGenerateNotes,
}: {
	graph: Graph;
	status: Status;
	generatingNotes: boolean;
	onGenerateNotes: () => void;
}) {
	const byType = useMemo(() => {
		const map = new Map<NodeType, AzNode[]>();
		for (const n of graph.nodes) {
			const arr = map.get(n.type) ?? [];
			arr.push(n);
			map.set(n.type, arr);
		}
		return map;
	}, [graph]);

	const canGenerate = graph.nodes.length > 0 || status === "done";

	return (
		<div className="h-full w-full overflow-y-auto bg-background p-6 font-sans text-foreground">
			<h1 className="mb-1 text-lg font-semibold">Meeting outline</h1>
			<p className="mb-3 text-xs text-muted-foreground">
				{graph.nodes.length} nodes · {graph.edges.length} edges
			</p>

			{canGenerate && (
				<button
					type="button"
					onClick={onGenerateNotes}
					disabled={generatingNotes}
					className="mb-5 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{generatingNotes ? "Generating scratch pad…" : "Generate scratch pad"}
				</button>
			)}

			{graph.nodes.length === 0 && (
				<p className="text-sm italic text-muted-foreground">
					Waiting for the meeting to start producing nodes…
				</p>
			)}

			{SECTION_ORDER.map(({ type, label }) => {
				const nodes = byType.get(type);
				if (!nodes || nodes.length === 0) return null;
				return (
					<section key={type} className="mb-5">
						<h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
							{label} <span className="opacity-60">({nodes.length})</span>
						</h2>
						<ul className="space-y-1.5">
							{nodes.map((node) => (
								<li key={node.id} className="text-sm leading-snug">
									<span className="font-medium">{node.label}</span>
									{node.speaker && (
										<span className="text-xs text-muted-foreground">
											{" "}
											— {node.speaker}
										</span>
									)}
									{node.description && (
										<div className="ml-3 text-xs text-muted-foreground">
											{node.description}
										</div>
									)}
								</li>
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}
