import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { PositionMap } from "@/hooks/useForceLayout";
import type { Status } from "@/hooks/useMeetingSession";
import type { Graph } from "@/lib/aizuchi/schemas";

/**
 * AIZ-12 — push the live meeting state to a debug file the CLI can
 * read (`~/.aizuchi/debug/current-meeting.json`). External inspection
 * tools (`aizuchi meeting inspect`, ad-hoc `cat`) consume this so we
 * don't have to round-trip through screenshots when the user wants a
 * second opinion on what gemma produced.
 *
 * Writes are debounced — the d3-force simulation ticks at ~60fps and
 * we don't want to thrash the disk. 400ms of quiet means "this state
 * is settled enough; flush it." The shape is loose JSON; the consumer
 * controls how strict it wants to be.
 */
export function useMeetingDebugSnapshot(input: {
	id: string;
	name?: string;
	status: Status;
	mode?: "live" | "demo" | "import";
	graph: Graph;
	positions: PositionMap;
	highlightIds: ReadonlySet<string>;
}): void {
	const lastWriteRef = useRef<string>("");

	useEffect(() => {
		const handle = window.setTimeout(() => {
			const positionsObj: Record<string, [number, number]> = {};
			for (const [id, p] of input.positions) {
				positionsObj[id] = [Math.round(p.x), Math.round(p.y)];
			}
			const snapshot = {
				id: input.id,
				name: input.name ?? null,
				status: input.status,
				mode: input.mode ?? null,
				updatedAt: new Date().toISOString(),
				graph: input.graph,
				positions: positionsObj,
				highlightIds: [...input.highlightIds],
			};
			// Skip the write when the snapshot hasn't changed — d3 ticks
			// keep firing as the simulation jitters around alpha=0.001
			// even when nothing structurally moved.
			const serialized = JSON.stringify(snapshot);
			if (serialized === lastWriteRef.current) return;
			lastWriteRef.current = serialized;
			invoke("write_meeting_debug", { snapshot }).catch((err) => {
				console.warn("[meeting-debug] write failed:", err);
			});
		}, 400);
		return () => window.clearTimeout(handle);
	}, [
		input.id,
		input.name,
		input.status,
		input.mode,
		input.graph,
		input.positions,
		input.highlightIds,
	]);

	// Clear on unmount so external readers don't see a stale graph
	// after the meeting window closes.
	useEffect(() => {
		return () => {
			invoke("clear_meeting_debug").catch(() => {});
		};
	}, []);
}
