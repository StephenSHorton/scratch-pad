import type { EdgeProps, InternalNode, Node } from "@xyflow/react";

import {
	BaseEdge,
	getBezierPath,
	getSimpleBezierPath,
	Position,
	useInternalNode,
} from "@xyflow/react";

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
 * Get the on-screen coordinates of a node's handle on a specific side.
 * `handleType` (`source` / `target`) and `handlePosition` (Left/Right/Top/
 * Bottom) together identify the exact Handle whose center we want to
 * anchor the edge to.
 */
const getHandleCoordsByPosition = (
	node: InternalNode<Node>,
	handleType: "source" | "target",
	handlePosition: Position,
) => {
	const handle = node.internals.handleBounds?.[handleType]?.find(
		(h) => h.position === handlePosition,
	);

	if (!handle) {
		return [0, 0] as const;
	}

	let offsetX = handle.width / 2;
	let offsetY = handle.height / 2;

	// The handle position that gets calculated has the origin top-left, so depending which side we are using, we add a little offset
	// so the marker-end sits flush with the node edge instead of inside it.
	switch (handlePosition) {
		case Position.Left: {
			offsetX = 0;
			break;
		}
		case Position.Right: {
			offsetX = handle.width;
			break;
		}
		case Position.Top: {
			offsetY = 0;
			break;
		}
		case Position.Bottom: {
			offsetY = handle.height;
			break;
		}
		default: {
			throw new Error(`Invalid handle position: ${handlePosition}`);
		}
	}

	const x = node.internals.positionAbsolute.x + handle.x + offsetX;
	const y = node.internals.positionAbsolute.y + handle.y + offsetY;

	return [x, y] as const;
};

/**
 * AIZ-12 — pull the chosen handle ids off the edge and resolve them to
 * actual on-screen coordinates. The edge ids follow a `s-<side>` /
 * `t-<side>` convention emitted by `meeting.$id.tsx::pickHandles`. If
 * an edge has no explicit handle (legacy / unknown), fall back to
 * right→left so the geometry isn't catastrophic.
 */
const handleIdToPosition = (
	id: string | null | undefined,
	fallback: Position,
): Position => {
	if (!id) return fallback;
	if (id.endsWith("-left")) return Position.Left;
	if (id.endsWith("-right")) return Position.Right;
	if (id.endsWith("-top")) return Position.Top;
	if (id.endsWith("-bottom")) return Position.Bottom;
	return fallback;
};

const Animated = ({
	id,
	source,
	target,
	sourceHandle,
	targetHandle,
	markerEnd,
	style,
}: EdgeProps) => {
	const sourceNode = useInternalNode(source);
	const targetNode = useInternalNode(target);

	if (!(sourceNode && targetNode)) {
		return null;
	}

	const sourcePos = handleIdToPosition(sourceHandle, Position.Right);
	const targetPos = handleIdToPosition(targetHandle, Position.Left);
	const [sx, sy] = getHandleCoordsByPosition(sourceNode, "source", sourcePos);
	const [tx, ty] = getHandleCoordsByPosition(targetNode, "target", targetPos);

	const [edgePath] = getBezierPath({
		sourcePosition: sourcePos,
		sourceX: sx,
		sourceY: sy,
		targetPosition: targetPos,
		targetX: tx,
		targetY: ty,
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
