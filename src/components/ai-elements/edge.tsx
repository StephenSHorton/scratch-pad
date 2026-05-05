import type { EdgeProps } from "@xyflow/react";
import { BaseEdge, getBezierPath, getSimpleBezierPath } from "@xyflow/react";

const Temporary = ({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
}: EdgeProps) => {
	const [edgePath] = getSimpleBezierPath({
		sourcePosition,
		sourceX,
		sourceY,
		targetPosition,
		targetX,
		targetY,
	});

	return (
		<BaseEdge
			className="stroke-1 stroke-ring"
			id={id}
			path={edgePath}
			style={{
				strokeDasharray: "5, 5",
			}}
		/>
	);
};

/**
 * AIZ-12 — read endpoint coords + sides directly off EdgeProps. ReactFlow
 * already resolves these from the edge's `sourceHandle` / `targetHandle`
 * ids set by `meeting.$id.tsx::pickHandles`, so we don't need to walk
 * `useInternalNode` ourselves. The previous version did a custom
 * handleBounds lookup that ignored top/bottom handles entirely — every
 * edge rendered as right→left regardless of geometry.
 */
const Animated = ({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	markerEnd,
	style,
}: EdgeProps) => {
	const [edgePath] = getBezierPath({
		sourcePosition,
		sourceX,
		sourceY,
		targetPosition,
		targetX,
		targetY,
	});

	return (
		<>
			<BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
			<circle fill="var(--primary)" r="4">
				<animateMotion dur="2s" path={edgePath} repeatCount="indefinite" />
			</circle>
		</>
	);
};

export const Edge = {
	Animated,
	Temporary,
};
