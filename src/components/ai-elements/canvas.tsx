import type { ReactFlowProps } from "@xyflow/react";
import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";

type CanvasProps = ReactFlowProps & {
	children?: ReactNode;
};

const deleteKeyCode = ["Backspace", "Delete"];

/**
 * AIZ-12 — observation mode by default. Drag the empty canvas to pan;
 * the selection-box behavior is off because the meeting graph is
 * read-only from the user's POV (the AI mutates it). Trackpad scroll
 * also pans (panOnScroll), and ctrl/cmd-scroll zooms.
 */
export const Canvas = ({ children, ...props }: CanvasProps) => (
	<ReactFlow
		deleteKeyCode={deleteKeyCode}
		fitView
		minZoom={0.1}
		panOnDrag
		panOnScroll
		selectionOnDrag={false}
		nodesDraggable={false}
		nodesConnectable={false}
		elementsSelectable={false}
		zoomOnDoubleClick={false}
		{...props}
	>
		<Background bgColor="var(--sidebar)" />
		<Controls showInteractive={false} />
		<MiniMap pannable zoomable />
		{children}
	</ReactFlow>
);
